import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { z } from 'zod';
import {
  ListingEntity,
  UserEntity,
  BookingEntity,
  NotificationLogEntity,
  PaymentEntity,
  DisputeCaseEntity,
  VerificationRequestEntity,
  VerificationAuditLogEntity,
} from '../entities';
import { NotificationsService } from '../notifications/notifications.service';
import { ListingTranslationService } from '../listings/listing-translation.service';
import { ListingsService } from '../listings/listings.service';
import { BookingsService } from '../bookings/bookings.service';
import { StorageService } from '../storage/storage.service';
import { agreeTerms } from '../common/domain';
import { evaluateCaptureEvidence, type CaptureEvidence } from '../listings/capture-evidence.util';

type AuditEvent = {
  id: string;
  kind: 'telemetry';
  title: string;
  desc: string;
  actor: string;
  time: string;
};

const AUDIT_EVENT_TYPES = ['telemetry_check', 'telemetry_passed', 'telemetry_failed'];

const NEGATIVE_STATUSES = ['changes_needed', 'rejected'] as const;

const OVERRIDE_REASON_MIN_LENGTH = 10;

const reviewSchema = z
  .object({
    status: z.enum(['in_review', 'changes_needed', 'live', 'paused', 'rejected']).optional(),
    reviewNotes: z.string().trim().max(2000).optional(),
    reviewReasonCategory: z.enum(['telemetry', 'listing_content', 'other']).optional(),
    markVisitPassed: z.boolean().optional(),
    overrideChecks: z.boolean().optional(),
    overrideReason: z.string().trim().max(2000).optional(),
  })
  .refine(
    (body) =>
      !body.status ||
      !(NEGATIVE_STATUSES as readonly string[]).includes(body.status) ||
      (!!body.reviewReasonCategory && !!body.reviewNotes?.trim()),
    {
      message: 'A reason category and an explanation are required to request changes or reject a listing.',
    },
  )
  .refine((body) => !body.overrideChecks || (body.overrideReason?.trim().length ?? 0) >= OVERRIDE_REASON_MIN_LENGTH, {
    message: `A reason of at least ${OVERRIDE_REASON_MIN_LENGTH} characters is required to approve with unmet checks.`,
  });

export type ReviewDecisionInput = z.infer<typeof reviewSchema>;

const VERIFICATION_TYPES = ['identity', 'selfie'] as const;

function resolveIsHost(p: { isHost?: unknown; role?: unknown }): boolean {
  if (typeof p.isHost === 'boolean') return p.isHost;
  return p.role === 'host';
}

function resolveIsAdmin(p: { role?: unknown }): boolean {
  return p.role === 'admin';
}

type LayerStatus = 'passed' | 'submitted' | 'failed' | 'not_started';

const REQUEST_STATUS_TO_LAYER: Record<string, LayerStatus> = {
  verified: 'passed',
  pending: 'submitted',
  rejected: 'failed',
};

const LISTING_MEDIA_BUCKET = 'listing-media';

function latestRequestByType(requests: VerificationRequestEntity[]): Map<string, VerificationRequestEntity> {
  const latest = new Map<string, VerificationRequestEntity>();
  for (const request of requests) {
    if (!latest.has(request.verification_type)) latest.set(request.verification_type, request);
  }
  return latest;
}

function requestLayerStatus(request: VerificationRequestEntity | undefined): LayerStatus {
  return request ? (REQUEST_STATUS_TO_LAYER[request.status] ?? 'not_started') : 'not_started';
}

function resolveTelemetryStatus(evidence: CaptureEvidence): LayerStatus {
  return evidence.status;
}

function resolveVisitStatus(row: ListingEntity, draft: Record<string, any>): string {
  return row.visit_status || draft.visit?.status || 'not_started';
}

function resolveLayerStatuses(row: ListingEntity) {
  const draft = (row.draft_data as Record<string, any>) || {};
  const evidence = evaluateCaptureEvidence(draft);
  return {
    telemetry: resolveTelemetryStatus(evidence),
    telemetryProblems: evidence.problems,
    evidence,
    visit: resolveVisitStatus(row, draft),
  };
}

export function approvalBlockers(layers: { telemetry: string; telemetryProblems?: string[] }): string[] {
  const blockers: string[] = [];
  if (layers.telemetry !== 'passed') {
    const why = layers.telemetryProblems?.length ? ` (${layers.telemetryProblems.join('; ')})` : '';
    blockers.push(`Camera capture is ${layers.telemetry.replace('_', ' ')}${why}`);
  }
  return blockers;
}

function listingMediaPath(url: string): string | null {
  const marker = `/${LISTING_MEDIA_BUCKET}/`;
  const at = url.indexOf(marker);
  if (at === -1) return null;
  return decodeURIComponent(url.slice(at + marker.length).split('?')[0]);
}

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    @InjectRepository(ListingEntity) private readonly listings: Repository<ListingEntity>,
    @InjectRepository(UserEntity) private readonly profiles: Repository<UserEntity>,
    @InjectRepository(BookingEntity) private readonly bookings: Repository<BookingEntity>,
    @InjectRepository(NotificationLogEntity) private readonly notificationLog: Repository<NotificationLogEntity>,
    @InjectRepository(PaymentEntity) private readonly payments: Repository<PaymentEntity>,
    @InjectRepository(DisputeCaseEntity) private readonly disputeCases: Repository<DisputeCaseEntity>,
    @InjectRepository(VerificationRequestEntity) private readonly verificationRequests: Repository<VerificationRequestEntity>,
    @InjectRepository(VerificationAuditLogEntity) private readonly verificationAuditLog: Repository<VerificationAuditLogEntity>,
    private readonly notifications: NotificationsService,
    private readonly listingTranslations: ListingTranslationService,
    private readonly listingsService: ListingsService,
    private readonly bookingsService: BookingsService,
    private readonly storage: StorageService,
  ) {}

  async getAudits(): Promise<{ audits: AuditEvent[]; total: number }> {
    const rows = await this.notificationLog
      .createQueryBuilder('n')
      .where('n.event IN (:...types)', { types: AUDIT_EVENT_TYPES })
      .orderBy('n.sent_at', 'DESC')
      .limit(50)
      .getMany();

    if (rows.length > 0) {
      const audits: AuditEvent[] = rows.map((row) => {
        const payload = (row.payload as any) || {};
        const kind: AuditEvent['kind'] = 'telemetry';

        const passed = row.event.includes('passed');
        const failed = row.event.includes('failed');
        const statusLabel = passed ? 'Passed ✓' : failed ? 'Failed ✗' : 'Checked';

        return {
          id: row.id,
          kind,
          title: `${kind.charAt(0).toUpperCase() + kind.slice(1)} Verification — ${statusLabel}`,
          desc:
            payload.notes ||
            payload.message ||
            `Automated ${kind} check completed for listing ${payload.listing_id || '—'}.`,
          actor: payload.actor || 'Basera System',
          time: new Date(row.sent_at).toLocaleString('en-IN', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          }),
        };
      });

      return { audits, total: audits.length };
    }

    const listings = await this.listings
      .createQueryBuilder('l')
      .orderBy('l.updated_at', 'DESC')
      .limit(30)
      .getMany();

    const synthesised: AuditEvent[] = [];
    for (const l of listings) {
      const draft = (l.draft_data as any) || {};
      const telemetry = draft.telemetry || {};

      const when = new Date(l.updated_at || l.created_at).toLocaleString('en-IN', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });

      if (telemetry.status) {
        const capture = telemetry.walkthroughCheck?.capture;
        synthesised.push({
          id: `telemetry-${l.id}`,
          kind: 'telemetry',
          title: `Camera capture — ${telemetry.status === 'passed' ? 'Passed ✓' : telemetry.status === 'failed' ? 'Failed ✗' : 'Awaiting review'}`,
          desc:
            typeof capture?.distanceFromPinM === 'number'
              ? `Walkthrough recorded with the in-app camera; the device reported ${capture.distanceFromPinM} m from the pin (device-reported, not verified).`
              : 'Walkthrough submitted before camera capture, or without capture data.',
          actor: 'Basera Capture Check',
          time: when,
        });
      }
    }

    return { audits: synthesised, total: synthesised.length };
  }

  async getProperties(statusParam?: string, q?: string, page = 1, pageSize = 20) {
    const query = q?.toLowerCase();

    const qb = this.listings.createQueryBuilder('l').orderBy('l.created_at', 'DESC');
    if (statusParam) qb.andWhere('l.status = :status', { status: statusParam });

    let matchedTotal: number | undefined;
    let rows: ListingEntity[];
    if (query) {
      rows = await qb.getMany();
    } else {
      qb.skip((page - 1) * pageSize).take(pageSize);
      [rows, matchedTotal] = await qb.getManyAndCount();
    }

    const hostIds = Array.from(new Set(rows.map((r) => r.host_id).filter(Boolean)));
    const profiles = hostIds.length > 0
      ? await this.profiles.find({ where: hostIds.map((id) => ({ id })) })
      : [];
    const profileMap = new Map(profiles.map((p) => [p.id, p]));

    const hostRequests = hostIds.length > 0
      ? await this.verificationRequests.find({
          where: hostIds.map((id) => ({ user_id: id })),
          select: {
            id: true,
            user_id: true,
            verification_type: true,
            status: true,
            document_path: true,
            submitted_at: true,
          },
          order: { submitted_at: 'DESC' },
        })
      : [];
    const requestsByHost = new Map<string, VerificationRequestEntity[]>();
    for (const request of hostRequests) {
      const list = requestsByHost.get(request.user_id) ?? [];
      list.push(request);
      requestsByHost.set(request.user_id, list);
    }

    const properties = rows.map((row) => {
      const draft = (row.draft_data as any) || {};
      const propStep = draft.property_details || draft.property || draft.basics || {};
      const addressStep = draft.address || draft.location || {};
      const telemetryStep = draft.telemetry || {};
      const mediaStep = draft.media || {};

      const profile = profileMap.get(row.host_id) || ({} as Partial<UserEntity>);
      const requests = requestsByHost.get(row.host_id) ?? [];
      const latestRequests = latestRequestByType(requests);
      const layerStatus = resolveLayerStatuses(row);
      const verificationCheck = (type: string) => {
        const request = latestRequests.get(type);
        return { status: requestLayerStatus(request), requestId: request?.id ?? null, hasDocument: !!request?.document_path };
      };

      const title =
        propStep.title ||
        addressStep.fullAddress ||
        addressStep.line1 ||
        `Mountain Stay (#${row.id.slice(0, 6)})`;
      const town = propStep.town || addressStep.town || addressStep.city || 'Dharamshala';
      const state = addressStep.state || 'Himachal Pradesh';
      const dailyBaseRate = typeof propStep.dailyBaseRate === 'number' ? propStep.dailyBaseRate : null;
      const monthlyTerms =
        dailyBaseRate !== null
          ? agreeTerms(dailyBaseRate, propStep.weeklyDiscountPct ?? 0, propStep.monthlyDiscountPct ?? 0, 30)
          : null;
      const legacyRent = propStep.price || propStep.monthlyRent || null;
      const price: number | null = monthlyTerms ? monthlyTerms.totalRent : legacyRent;
      const deposit: number | null = monthlyTerms ? monthlyTerms.deposit : propStep.deposit || legacyRent;
      const beds = propStep.beds || (propStep.bedrooms ? `${propStep.bedrooms} BHK` : '1 room · private bath');
      const term = propStep.minDays
        ? `${propStep.minDays} ${propStep.minDays === 1 ? 'day' : 'days'}`
        : propStep.minMonths
          ? `${propStep.minMonths} mo`
          : '—';
      const pinLat = typeof propStep.lat === 'number' ? propStep.lat : telemetryStep.coords?.lat;
      const pinLng = typeof propStep.lng === 'number' ? propStep.lng : telemetryStep.coords?.lng;

      const photos: string[] =
        propStep.photos && propStep.photos.length > 0
          ? propStep.photos.map((p: { url: string } | string) => (typeof p === 'string' ? p : p.url))
          : [
              `https://picsum.photos/seed/${row.id}-1/900/600`,
              `https://picsum.photos/seed/${row.id}-2/900/600`,
            ];

      return {
        id: row.id,
        title,
        town,
        state,
        hostId: row.host_id || '',
        hostName: profile.full_name || 'Unknown Host',
        hostPhone: profile.phone || '',
        hostEmail: profile.email || '',
        hostAvatar: profile.avatar_url || undefined,
        price,
        deposit,
        beds,
        term,
        status: row.status || 'draft',
        submittedAt: row.created_at
          ? new Date(row.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
          : '—',
        trustScore: draft.trustScore || 70,
        layers: {
          telemetry: {
            status: layerStatus.telemetry,
            walkthroughVideoUrl: telemetryStep.walkthroughVideoUrl || undefined,
            videoUrl: mediaStep.videoUrl,
            tourUrl: mediaStep.tourUrl,
            problems: layerStatus.telemetryProblems,
            captures: layerStatus.evidence,
            pin: typeof pinLat === 'number' && typeof pinLng === 'number' ? { lat: pinLat, lng: pinLng } : undefined,
            wifiSpeedMbps: typeof draft.wifi?.downMbps === 'number' ? draft.wifi.downMbps : undefined,
            wifi: draft.wifi ?? undefined,
          },
          visit: {
            status: layerStatus.visit,
            inspectorName: draft.visit?.inspectorName,
            visitDate: draft.visit?.visitDate,
            notes: draft.visit?.notes,
          },
        },
        verification: {
          identity: verificationCheck('identity'),
          selfie: verificationCheck('selfie'),
        },
        reviewNotes: row.review_notes || undefined,
        photos,
        amenities: propStep.amenities || [],
        rules: propStep.rules || propStep.houseRules || [],
      };
    });

    let filtered = properties;
    let total = filtered.length;
    if (query) {
      filtered = filtered.filter(
        (p) =>
          p.title.toLowerCase().includes(query) ||
          p.town.toLowerCase().includes(query) ||
          p.hostName.toLowerCase().includes(query),
      );
      total = filtered.length;
      filtered = filtered.slice((page - 1) * pageSize, page * pageSize);
    } else {
      total = matchedTotal ?? total;
    }

    const counts: Record<string, number> = {
      all: 0,
      in_review: 0,
      live: 0,
      changes_needed: 0,
      draft: 0,
    };

    const countRows: { status: string; count: string }[] = await this.listings
      .createQueryBuilder('l')
      .select('l.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('l.status')
      .getRawMany();

    for (const { status, count } of countRows) {
      const n = Number(count);
      counts.all += n;
      if (status in counts) counts[status] += n;
    }

    return { properties: filtered, counts, total, page, pageSize };
  }

  async reviewProperty(id: string, adminUserId: string, body: unknown) {
    const parsed = reviewSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'Invalid review payload');
    }

    const { status, reviewNotes, reviewReasonCategory, markVisitPassed, overrideChecks, overrideReason } = parsed.data;

    if (!status && reviewNotes === undefined && !markVisitPassed) {
      throw new BadRequestException('Nothing to update');
    }

    const before = await this.listings.findOne({ where: { id } });
    if (!before) {
      throw new NotFoundException('Listing not found');
    }
    const previousStatus = before.status;

    let approvalOverride: Record<string, unknown> | undefined;
    if (status === 'live') {
      const layers = resolveLayerStatuses(before);
      const blockers = approvalBlockers(layers);
      if (blockers.length > 0) {
        if (!overrideChecks) {
          throw new ConflictException(
            `Cannot approve yet: ${blockers.join('; ')}. Complete these checks, or approve with an override and a reason.`,
          );
        }
        approvalOverride = {
          at: new Date().toISOString(),
          adminId: adminUserId,
          reason: overrideReason!.trim(),
          unmetChecks: blockers,
          previousStatus,
        };
        this.logger.warn(
          `Listing ${id} approved by admin ${adminUserId} with unmet checks (${blockers.join('; ')}): ${overrideReason!.trim()}`,
        );
      }
    }

    const updates: {
      updated_at: Date;
      reviewed_by: string;
      reviewed_at: Date;
      status?: string;
      review_notes?: string;
      review_reason_category?: string;
      visit_status?: string;
      draft_data?: Record<string, any>;
    } = {
      updated_at: new Date(),
      reviewed_by: adminUserId,
      reviewed_at: new Date(),
    };
    if (status) updates.status = status;
    if (reviewNotes !== undefined) updates.review_notes = reviewNotes;
    if (reviewReasonCategory !== undefined) updates.review_reason_category = reviewReasonCategory;
    if (markVisitPassed) updates.visit_status = 'passed';
    if (approvalOverride) {
      const draft = (before.draft_data as Record<string, any>) || {};
      updates.draft_data = { ...draft, approval_overrides: [...(draft.approval_overrides ?? []), approvalOverride] };
    }

    await this.listings.update({ id }, updates);

    const data = await this.listings.findOne({ where: { id } });
    if (!data) {
      throw new NotFoundException('Listing not found');
    }

    const listingTitle = (data.draft_data as any)?.property_details?.title ?? 'your listing';
    const statusChanged = !!status && status !== previousStatus;
    if (statusChanged && (status === 'live' || previousStatus === 'live')) {
      await this.listingsService.bumpSearchCacheVersion();
    }
    if (statusChanged && status === 'live') {
      this.notifications.notify('listing.live', data.host_id, {
        listingTitle,
        pushTitle: 'Your listing is live',
        pushBody: `${listingTitle} is now visible to guests on Basera`,
        link: `/host/listings`,
      });
      void this.listingTranslations.prewarmSourceLocale(data);
    } else if (statusChanged && status === 'changes_needed') {
      this.notifications.notify('listing.changes_needed', data.host_id, {
        listingTitle,
        failReason: reviewNotes,
        pushTitle: 'Action needed on your listing',
        pushBody: `${listingTitle} needs a correction before it can go live`,
        link: `/host/listings`,
      });
    }

    const { draft_data: _draft_data, ...listing } = data;
    return { success: true, listing };
  }

  async getWalkthroughVideoUrl(id: string) {
    const row = await this.listings.findOne({ where: { id }, select: { id: true, draft_data: true } });
    if (!row) {
      throw new NotFoundException('Listing not found');
    }
    const storedUrl: unknown = (row.draft_data as Record<string, any> | null)?.telemetry?.walkthroughVideoUrl;
    if (typeof storedUrl !== 'string' || !storedUrl) {
      throw new NotFoundException('This listing has no walkthrough video on file.');
    }

    const path = listingMediaPath(storedUrl);
    if (!path) {
      return { url: storedUrl };
    }
    try {
      return { url: await this.storage.createSignedDownloadUrl(LISTING_MEDIA_BUCKET, path, 3600) };
    } catch (err) {
      this.logger.warn(`Walkthrough video for listing ${id} could not be signed: ${(err as Error).message}`);
      throw new NotFoundException('The walkthrough video file was not found in storage. The host may need to re-record it.');
    }
  }

  async getStats() {
    const [statusCounts, totalUsers, geoLockRow] = await Promise.all([
      this.listings
        .createQueryBuilder('l')
        .select('l.status', 'status')
        .addSelect('COUNT(*)', 'count')
        .groupBy('l.status')
        .getRawMany<{ status: string; count: string }>(),
      this.profiles.count(),
      this.listings
        .createQueryBuilder('l')
        .select('COUNT(*)', 'total')
        .addSelect(
          "COUNT(*) FILTER (WHERE l.draft_data -> 'telemetry' ->> 'walkthroughPassed' = 'true' AND l.draft_data -> 'telemetry' -> 'walkthroughCheck' ->> 'method' IN ('camera_captured', 'unanalysed') AND l.draft_data -> 'telemetry' -> 'walkthroughCheck' -> 'capture' IS NOT NULL)",
          'passed',
        )
        .where("l.status <> 'draft'")
        .getRawOne<{ total: string; passed: string }>(),
    ]);

    const byStatus = new Map(statusCounts.map((r) => [r.status, Number(r.count)]));
    const totalProperties = statusCounts.reduce((sum, r) => sum + Number(r.count), 0);
    const pendingReviews = byStatus.get('in_review') ?? 0;
    const liveProperties = byStatus.get('live') ?? 0;
    const changesNeeded = byStatus.get('changes_needed') ?? 0;
    const draftProperties = byStatus.get('draft') ?? 0;

    return {
      stats: {
        totalProperties,
        pendingReviews,
        liveProperties,
        changesNeeded,
        draftProperties,
        totalUsers,
        geoLock: { passed: Number(geoLockRow?.passed ?? 0), total: Number(geoLockRow?.total ?? 0) },
      },
    };
  }

  async getUsers(roleParam?: string, q?: string, page = 1, pageSize = 20) {
    const query = q?.toLowerCase();

    const qb = this.profiles.createQueryBuilder('p').orderBy('p.created_at', 'DESC');
    if (roleParam === 'host') {
      qb.andWhere("(p.isHost = true OR p.role = 'host')");
    } else if (roleParam === 'admin') {
      qb.andWhere("p.role = 'admin'");
    } else if (roleParam === 'guest') {
      qb.andWhere("(p.isHost IS NOT TRUE AND p.role != 'host') AND p.role != 'admin'");
    }

    let matchedTotal: number | undefined;
    let profiles: UserEntity[];
    if (query) {
      profiles = await qb.getMany();
    } else {
      qb.skip((page - 1) * pageSize).take(pageSize);
      [profiles, matchedTotal] = await qb.getManyAndCount();
    }

    const hostIds = profiles.map((p) => p.id);
    const listingCountRows = hostIds.length > 0
      ? await this.listings
          .createQueryBuilder('l')
          .select('l.host_id', 'host_id')
          .addSelect('COUNT(*)', 'count')
          .where('l.host_id IN (:...hostIds)', { hostIds })
          .groupBy('l.host_id')
          .getRawMany<{ host_id: string; count: string }>()
      : [];

    const countMap = new Map(listingCountRows.map((r) => [r.host_id, Number(r.count)]));

    const identityRows = hostIds.length > 0
      ? await this.verificationRequests.find({
          where: { user_id: In(hostIds), verification_type: 'identity' },
          select: { id: true, user_id: true, status: true, submitted_at: true },
          order: { submitted_at: 'DESC' },
        })
      : [];
    const identityVerified = new Set<string>();
    const seenIdentity = new Set<string>();
    for (const r of identityRows) {
      if (seenIdentity.has(r.user_id)) continue;
      seenIdentity.add(r.user_id);
      if (r.status === 'verified') identityVerified.add(r.user_id);
    }

    let users = profiles.map((p) => {
      const isHost = resolveIsHost(p);
      const isAdmin = resolveIsAdmin(p);
      return {
        id: p.id,
        name: p.full_name || p.email?.split('@')[0] || 'Unknown',
        email: p.email || '',
        phone: p.phone || '',
        isHost,
        isAdmin,
        tier: 1,
        trustScore: 70,
        joinedYear: p.created_at ? new Date(p.created_at).getFullYear() : 2026,
        avatarSeed: p.id.slice(0, 8),
        avatarUrl: p.avatar_url || undefined,
        status: 'active' as const,
        propertiesCount: countMap.get(p.id) || 0,
        kycStatus: (p.selfie_uploaded_at && identityVerified.has(p.id) ? 'verified' : 'not_submitted') as
          | 'verified'
          | 'in_review'
          | 'not_submitted',
      };
    });

    let total = matchedTotal ?? users.length;
    if (query) {
      users = users.filter(
        (u) =>
          u.name.toLowerCase().includes(query) ||
          u.email.toLowerCase().includes(query) ||
          (u.phone && u.phone.toLowerCase().includes(query)),
      );
      total = users.length;
      users = users.slice((page - 1) * pageSize, page * pageSize);
    }

    const [allCount, hostCount, adminCount] = await Promise.all([
      this.profiles.count(),
      this.profiles
        .createQueryBuilder('p')
        .where("(p.isHost = true OR p.role = 'host') AND p.role != 'admin'")
        .getCount(),
      this.profiles.createQueryBuilder('p').where("p.role = 'admin'").getCount(),
    ]);
    const counts = {
      all: allCount,
      hosts: hostCount,
      admins: adminCount,
      guests: allCount - hostCount - adminCount,
    };

    return { users, counts, total, page, pageSize };
  }

  async setIsHost(id: string, isHost: unknown) {
    if (typeof isHost !== 'boolean') {
      throw new BadRequestException('isHost must be a boolean');
    }
    await this.profiles.update({ id }, { isHost });
    const data = await this.profiles.findOne({ where: { id }, select: { id: true, isHost: true } });
    if (!data) {
      throw new NotFoundException('User not found');
    }
    return { success: true, user: data };
  }

  async getPayments(status?: string) {
    const qb = this.payments.createQueryBuilder('p').orderBy('p.created_at', 'DESC');
    if (status) qb.andWhere('p.status = :status', { status });
    const rows = await qb.getMany();

    const bookingIds = Array.from(new Set(rows.map((r) => r.booking_id)));
    const bookingRows = bookingIds.length
      ? await this.bookings.find({ where: bookingIds.map((id) => ({ id })) })
      : [];
    const bookingById = new Map(bookingRows.map((b) => [b.id, b]));

    const payments = rows.map((row) => {
      const booking = bookingById.get(row.booking_id);
      return {
        id: row.id,
        bookingId: row.booking_id,
        bookingStatus: booking?.status ?? null,
        amount: row.amount,
        cashfreeOrderId: row.cashfree_order_id,
        cashfreePayoutId: row.cashfree_payout_id,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });

    return { payments, total: payments.length };
  }

  async getDisputes() {
    const rows = await this.bookings.find({ where: { status: 'disputed' }, order: { updated_at: 'DESC' } });
    if (rows.length === 0) {
      return { disputes: [], total: 0 };
    }

    const listingIds = Array.from(new Set(rows.map((r) => r.listing_id)));
    const partyIds = Array.from(new Set(rows.flatMap((r) => [r.guest_id, r.host_id])));

    const [listingRows, profileRows, paymentRows, caseRows] = await Promise.all([
      this.listings.find({ where: listingIds.map((id) => ({ id })), select: { id: true, draft_data: true } }),
      this.profiles.find({ where: partyIds.map((id) => ({ id })), select: { id: true, full_name: true } }),
      this.payments.find({ where: rows.map((r) => ({ booking_id: r.id })) }),
      this.disputeCases.find({ where: rows.map((r) => ({ booking_id: r.id })) }),
    ]);

    const titleById = new Map(
      listingRows.map((l) => [l.id, (l.draft_data as any)?.property_details?.title ?? 'Listing']),
    );
    const nameById = new Map(profileRows.map((p) => [p.id, p.full_name ?? 'Basera user']));
    const paymentByBookingId = new Map(paymentRows.map((p) => [p.booking_id, p]));
    const caseByBookingId = new Map(caseRows.map((c) => [c.booking_id, c]));

    const disputes = rows.map((row) => {
      const disputeCase = caseByBookingId.get(row.id);
      return {
        bookingId: row.id,
        listingId: row.listing_id,
        listingTitle: titleById.get(row.listing_id) ?? 'Listing',
        guestName: nameById.get(row.guest_id) ?? 'Basera user',
        hostName: nameById.get(row.host_id) ?? 'Basera user',
        category: disputeCase?.category ?? null,
        reason: disputeCase?.description ?? row.rejection_reason,
        requestedAmount: disputeCase?.requested_amount ?? null,
        evidenceUrls: disputeCase?.evidence_urls ?? [],
        caseStatus: disputeCase?.case_status ?? null,
        amount: paymentByBookingId.get(row.id)?.amount ?? row.due_at_move_in,
        checkinTime: row.checkin_time,
        updatedAt: row.updated_at,
      };
    });

    return { disputes, total: disputes.length };
  }

  async getDisputeCase(bookingId: string) {
    return this.bookingsService.getDisputeCaseForAdmin(bookingId);
  }

  async resolveDispute(bookingId: string, adminUserId: string, amountToGuest: number, message: string | undefined) {
    return this.bookingsService.resolveDispute(adminUserId, bookingId, amountToGuest, message);
  }

  async resolveAppeal(bookingId: string, adminUserId: string, amountToGuest: number, message: string | undefined) {
    return this.bookingsService.resolveAppeal(adminUserId, bookingId, amountToGuest, message);
  }

  async getVerificationRequestDetail(id: string) {
    const row = await this.verificationRequests.findOne({ where: { id } });
    if (!row) {
      throw new NotFoundException('Verification request not found');
    }

    const previousRows = await this.verificationRequests.find({
      where: { user_id: row.user_id, verification_type: row.verification_type },
      order: { submitted_at: 'DESC' },
    });
    const previousAttempts = previousRows
      .filter((r) => r.id !== row.id)
      .map((r) => ({
        id: r.id,
        status: r.status,
        rejectionReason: r.rejection_reason,
        submittedAt: r.submitted_at,
        reviewedAt: r.reviewed_at,
      }));

    const auditLogRows = await this.verificationAuditLog.find({
      where: { verification_request_id: id },
      order: { created_at: 'DESC' },
    });

    const reviewerIds = [row.reviewed_by, ...auditLogRows.map((a) => a.admin_id)].filter(
      (v): v is string => !!v,
    );
    const profileIds = Array.from(new Set([row.user_id, ...reviewerIds]));
    const profiles = await this.profiles.find({
      where: profileIds.map((pid) => ({ id: pid })),
      select: {
        id: true,
        full_name: true,
        phone: true,
      },
    });
    const profileById = new Map(profiles.map((p) => [p.id, p]));
    const submitterProfile = profileById.get(row.user_id);

    let documentUrl: string | null = null;
    if (row.document_path) {
      documentUrl = await this.storage.createSignedDownloadUrl('verification-documents', row.document_path, 300);
    }
    let documentBackUrl: string | null = null;
    if (row.document_path_back) {
      documentBackUrl = await this.storage.createSignedDownloadUrl('verification-documents', row.document_path_back, 300);
    }

    const auditLog = auditLogRows.map((a) => ({
      id: a.id,
      action: a.action,
      previousStatus: a.previous_status,
      newStatus: a.new_status,
      rejectionReason: a.rejection_reason,
      adminId: a.admin_id,
      adminName: a.admin_id ? (profileById.get(a.admin_id)?.full_name ?? null) : null,
      createdAt: a.created_at,
    }));

    return {
      id: row.id,
      userId: row.user_id,
      userName: submitterProfile?.full_name ?? 'Basera user',
      userPhone: submitterProfile?.phone ?? '',
      verificationType: row.verification_type,
      documentSubtype: row.document_subtype,
      status: row.status,
      submittedAt: row.submitted_at,
      reviewedAt: row.reviewed_at,
      reviewedBy: row.reviewed_by ? (profileById.get(row.reviewed_by)?.full_name ?? null) : null,
      rejectionReason: row.rejection_reason,
      analysisResult: row.analysis_result,
      documentUrl,
      documentBackUrl,
      previousAttempts,
      auditLog,
    };
  }

  async getVerificationDocumentUrl(id: string) {
    const row = await this.verificationRequests.findOne({ where: { id }, select: { id: true, document_path: true } });
    if (!row) {
      throw new NotFoundException('Verification request not found');
    }
    if (!row.document_path) {
      throw new NotFoundException('This verification request has no document');
    }

    const url = await this.storage.createSignedDownloadUrl('verification-documents', row.document_path, 300);
    return { url };
  }

  async getUserVerificationSummary(userId: string) {
    const rows = await this.verificationRequests.find({
      where: { user_id: userId },
      order: { submitted_at: 'DESC' },
    });

    const reviewerIds = Array.from(new Set(rows.map((r) => r.reviewed_by).filter((id): id is string => !!id)));
    const reviewers = reviewerIds.length
      ? await this.profiles.find({ where: reviewerIds.map((id) => ({ id })), select: { id: true, full_name: true } })
      : [];
    const reviewerNameById = new Map(reviewers.map((p) => [p.id, p.full_name ?? 'Admin']));

    const toSummaryRow = (row: VerificationRequestEntity) => {
      const analysis = row.analysis_result as { errors?: unknown[] } | null;
      return {
        id: row.id,
        documentSubtype: row.document_subtype,
        status: row.status,
        submittedAt: row.submitted_at,
        reviewedAt: row.reviewed_at,
        reviewedBy: row.reviewed_by ? (reviewerNameById.get(row.reviewed_by) ?? 'Admin') : null,
        rejectionReason: row.rejection_reason,
        hasAnalysisErrors: Array.isArray(analysis?.errors) && analysis!.errors!.length > 0,
      };
    };

    const byType = new Map<string, VerificationRequestEntity[]>();
    for (const row of rows) {
      const list = byType.get(row.verification_type) ?? [];
      list.push(row);
      byType.set(row.verification_type, list);
    }

    const types = VERIFICATION_TYPES.map((type) => {
      const typeRows = byType.get(type) ?? [];
      const [current, ...previous] = typeRows;
      return {
        type,
        current: current ? toSummaryRow(current) : null,
        previousAttempts: previous.map(toSummaryRow),
      };
    });

    return { userId, types };
  }
}
