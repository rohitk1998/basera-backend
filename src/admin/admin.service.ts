import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { z } from 'zod';
import {
  ListingEntity,
  UserEntity,
  BookingEntity,
  NotificationLogEntity,
  PaymentEntity,
  HostSubscriptionEntity,
  DisputeCaseEntity,
  VerificationRequestEntity,
  VerificationAuditLogEntity,
} from '../entities';
import { NotificationsService } from '../notifications/notifications.service';
import { ListingTranslationService } from '../listings/listing-translation.service';
import { BookingsService } from '../bookings/bookings.service';
import { StorageService } from '../storage/storage.service';

type AuditEvent = {
  id: string;
  kind: 'telemetry' | 'banking' | 'legal';
  title: string;
  desc: string;
  actor: string;
  time: string;
};

const AUDIT_EVENT_TYPES = [
  'legal_check',
  'telemetry_check',
  'banking_check',
  'legal_passed',
  'telemetry_passed',
  'banking_passed',
  'legal_failed',
  'telemetry_failed',
  'banking_failed',
];

const NEGATIVE_STATUSES = ['changes_needed', 'rejected'] as const;

/** Mirrors ListingStatus in common/domain.ts. `draft` is absent on purpose:
 *  only a host moves a listing back to draft, never ops. */
const reviewSchema = z
  .object({
    status: z.enum(['in_review', 'changes_needed', 'live', 'paused', 'rejected']).optional(),
    reviewNotes: z.string().trim().max(2000).optional(),
    reviewReasonCategory: z.enum(['legal', 'telemetry', 'banking', 'listing_content', 'other']).optional(),
    markVisitPassed: z.boolean().optional(),
  })
  .refine(
    (body) =>
      !body.status ||
      !(NEGATIVE_STATUSES as readonly string[]).includes(body.status) ||
      (!!body.reviewReasonCategory && !!body.reviewNotes?.trim()),
    {
      // A host has no other way to learn what to fix — see
      // HostListings, which used to show only a generic "something needs
      // correcting" line regardless of the real reason.
      message: 'A reason category and an explanation are required to request changes or reject a listing.',
    },
  );

export type ReviewDecisionInput = z.infer<typeof reviewSchema>;

const VERIFICATION_TYPES = ['identity', 'pan', 'bank', 'legal', 'selfie'] as const;

/** Same reason-required-on-reject shape as reviewSchema above, for the
 *  verification_requests review decision. */
const verificationReviewSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    rejectionReason: z.string().trim().max(2000).optional(),
  })
  .refine((body) => body.decision !== 'reject' || !!body.rejectionReason?.trim(), {
    message: 'A rejection reason is required to reject a verification request.',
  });

export type VerificationReviewInput = z.infer<typeof verificationReviewSchema>;

const VERIFICATION_LAYER_NAME: Record<string, string> = {
  identity: 'identity',
  pan: 'PAN',
  bank: 'bank',
  legal: 'HP Tourism registration',
  selfie: 'selfie',
};

function resolveIsHost(p: { isHost?: unknown; role?: unknown }): boolean {
  if (typeof p.isHost === 'boolean') return p.isHost;
  return p.role === 'host';
}

function resolveIsAdmin(p: { role?: unknown }): boolean {
  return p.role === 'admin';
}

@Injectable()
export class AdminService {
  constructor(
    @InjectRepository(ListingEntity) private readonly listings: Repository<ListingEntity>,
    @InjectRepository(UserEntity) private readonly profiles: Repository<UserEntity>,
    @InjectRepository(BookingEntity) private readonly bookings: Repository<BookingEntity>,
    @InjectRepository(NotificationLogEntity) private readonly notificationLog: Repository<NotificationLogEntity>,
    @InjectRepository(PaymentEntity) private readonly payments: Repository<PaymentEntity>,
    @InjectRepository(HostSubscriptionEntity) private readonly subscriptions: Repository<HostSubscriptionEntity>,
    @InjectRepository(DisputeCaseEntity) private readonly disputeCases: Repository<DisputeCaseEntity>,
    @InjectRepository(VerificationRequestEntity) private readonly verificationRequests: Repository<VerificationRequestEntity>,
    @InjectRepository(VerificationAuditLogEntity) private readonly verificationAuditLog: Repository<VerificationAuditLogEntity>,
    private readonly notifications: NotificationsService,
    private readonly listingTranslations: ListingTranslationService,
    private readonly bookingsService: BookingsService,
    private readonly storage: StorageService,
  ) {}

  // --- audits -------------------------------------------------------------

  /**
   * The original route reads a `notification_events` table this backend's
   * scaffolding never got (only `notification_log` exists, and its columns
   * don't match — no `event_type`/`actor`/`listing_id`, those live inside
   * `payload`/`event` here). Approximated on `notification_log` filtered by
   * `event` instead of `event_type`; falls through to the listings
   * synthesis exactly as the original when that yields nothing. See report.
   */
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
        const kind: AuditEvent['kind'] = row.event.includes('legal')
          ? 'legal'
          : row.event.includes('banking')
            ? 'banking'
            : 'telemetry';

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
      const legal = draft.legal || {};
      const telemetry = draft.telemetry || {};
      const banking = draft.banking || {};

      const shortId = l.id.slice(0, 8);
      const when = new Date(l.updated_at || l.created_at).toLocaleString('en-IN', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });

      if (legal.status) {
        synthesised.push({
          id: `legal-${l.id}`,
          kind: 'legal',
          title: `HP Tourism Legal — ${legal.status === 'passed' ? 'Passed ✓' : legal.status === 'failed' ? 'Failed ✗' : 'Submitted'}`,
          desc:
            legal.notes ||
            `Certificate ${legal.hpTourismNumber || '—'} for operator ${legal.operatorName || shortId} checked against HP Tourism registry.`,
          actor: 'Basera Legal Bot',
          time: when,
        });
      }

      if (telemetry.status) {
        synthesised.push({
          id: `telemetry-${l.id}`,
          kind: 'telemetry',
          title: `Telemetry & GPS — ${telemetry.status === 'passed' ? 'Passed ✓' : telemetry.status === 'failed' ? 'Failed ✗' : 'Submitted'}`,
          desc: telemetry.gpsMatched
            ? `GPS lock confirmed at ${telemetry.coordinates || 'pinned coordinates'}. Walkthrough video verified.`
            : `15-second walkthrough submitted. GPS verification ${telemetry.status}.`,
          actor: 'Basera Telemetry System',
          time: when,
        });
      }

      if (banking.status) {
        synthesised.push({
          id: `banking-${l.id}`,
          kind: 'banking',
          title: `Banking Penny-Drop — ${banking.status === 'passed' ? 'Passed ✓' : banking.status === 'failed' ? 'Failed ✗' : 'Submitted'}`,
          desc:
            banking.pennyDropStatus === 'matched'
              ? `₹1 penny-drop confirmed. Account name "${banking.accountName || '—'}" matches PAN and certificate.`
              : `₹1 penny-drop initiated for UPI ${banking.upiId || '—'}.`,
          actor: 'Basera Banking Verification',
          time: when,
        });
      }
    }

    return { audits: synthesised, total: synthesised.length };
  }

  // --- properties -----------------------------------------------------------

  async getProperties(statusParam?: string, q?: string) {
    const query = q?.toLowerCase();

    const qb = this.listings.createQueryBuilder('l').orderBy('l.created_at', 'DESC');
    if (statusParam) qb.andWhere('l.status = :status', { status: statusParam });
    const rows = await qb.getMany();

    const hostIds = Array.from(new Set(rows.map((r) => r.host_id).filter(Boolean)));
    const profiles = hostIds.length > 0
      ? await this.profiles.find({ where: hostIds.map((id) => ({ id })) })
      : [];
    const profileMap = new Map(profiles.map((p) => [p.id, p]));

    const properties = rows.map((row) => {
      const draft = (row.draft_data as any) || {};
      const propStep = draft.property_details || draft.property || draft.basics || {};
      const addressStep = draft.address || draft.location || {};
      const legalStep = draft.legal || {};
      const telemetryStep = draft.telemetry || {};
      const bankingStep = draft.banking || {};
      const mediaStep = draft.media || {};

      const profile = profileMap.get(row.host_id) || ({} as Partial<UserEntity>);

      const title =
        propStep.title ||
        addressStep.fullAddress ||
        addressStep.line1 ||
        `Mountain Stay (#${row.id.slice(0, 6)})`;
      const town = propStep.town || addressStep.town || addressStep.city || 'Dharamshala';
      const state = addressStep.state || 'Himachal Pradesh';
      const price = propStep.price || propStep.monthlyRent || 12000;
      const deposit = propStep.deposit || price;
      const beds = propStep.beds || (propStep.bedrooms ? `${propStep.bedrooms} BHK` : '1 room · private bath');
      const term = propStep.minMonths ? `${propStep.minMonths}–12 mo` : '1–6 mo';

      // Photos live at draft.property_details.photos (photoSchema entries,
      // { url, room }), not a top-level draft.photos — see listing-mapper.ts
      // rowToListing() for the same convention on the public listing side.
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
          legal: {
            status: legalStep.status || 'not_started',
            hpTourismNumber: legalStep.registrationNumber || legalStep.registration_number || legalStep.hpTourismNumber,
            operatorName: legalStep.operatorName,
            notes: legalStep.notes,
          },
          telemetry: {
            status: telemetryStep.status || 'not_started',
            // The walkthrough video is the same upload as the public
            // listing's property video — mediaSchema.videoUrl, not a
            // separate telemetry-only field (telemetrySchema only ever
            // carries walkthroughPassed).
            videoUrl: mediaStep.videoUrl,
            tourUrl: mediaStep.tourUrl,
            gpsMatched: telemetryStep.walkthroughPassed ?? telemetryStep.gpsMatched ?? false,
            coordinates: telemetryStep.coordinates,
            wifiSpeedMbps: telemetryStep.wifiSpeedMbps,
          },
          banking: {
            status: bankingStep.status || 'not_started',
            pennyDropStatus: bankingStep.pennyDropStatus,
            accountName: bankingStep.accountName,
            upiId: bankingStep.upiId,
          },
          visit: {
            status: row.visit_status || draft.visit?.status || 'not_started',
            inspectorName: draft.visit?.inspectorName,
            visitDate: draft.visit?.visitDate,
            notes: draft.visit?.notes,
          },
        },
        reviewNotes: row.review_notes || undefined,
        photos,
        amenities: propStep.amenities || [],
        rules: propStep.rules || propStep.houseRules || [],
      };
    });

    let filtered = properties;
    if (query) {
      filtered = filtered.filter(
        (p) =>
          p.title.toLowerCase().includes(query) ||
          p.town.toLowerCase().includes(query) ||
          p.hostName.toLowerCase().includes(query),
      );
    }

    const counts: Record<string, number> = {
      all: 0,
      in_review: 0,
      live: 0,
      changes_needed: 0,
      draft: 0,
    };

    if (!statusParam) {
      for (const p of properties) {
        counts.all += 1;
        if (p.status === 'in_review') counts.in_review += 1;
        else if (p.status === 'live') counts.live += 1;
        else if (p.status === 'changes_needed') counts.changes_needed += 1;
        else if (p.status === 'draft') counts.draft += 1;
      }
    } else {
      const allForCounts = await this.listings.find({ select: { status: true } });
      for (const r of allForCounts) {
        counts.all += 1;
        if (r.status === 'in_review') counts.in_review += 1;
        else if (r.status === 'live') counts.live += 1;
        else if (r.status === 'changes_needed') counts.changes_needed += 1;
        else if (r.status === 'draft') counts.draft += 1;
      }
    }

    return { properties: filtered, counts, total: filtered.length };
  }

  // --- property review decision --------------------------------------------

  /**
   * This route was writing `review_notes` and `visit_status` before either
   * column existed on the original Supabase schema; Postgres rejected the
   * whole UPDATE on an unknown column, so every decision — `status` included
   * — was silently discarded. The columns exist on ListingEntity here, and
   * the body is validated rather than trusted.
   */
  async reviewProperty(id: string, adminUserId: string, body: unknown) {
    const parsed = reviewSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'Invalid review payload');
    }

    const { status, reviewNotes, reviewReasonCategory, markVisitPassed } = parsed.data;

    if (!status && reviewNotes === undefined && !markVisitPassed) {
      throw new BadRequestException('Nothing to update');
    }

    const before = await this.listings.findOne({ where: { id }, select: { id: true, status: true } });
    const previousStatus = before?.status;

    const updates: {
      updated_at: Date;
      reviewed_by: string;
      reviewed_at: Date;
      status?: string;
      review_notes?: string;
      review_reason_category?: string;
      visit_status?: string;
    } = {
      updated_at: new Date(),
      reviewed_by: adminUserId,
      reviewed_at: new Date(),
    };
    if (status) updates.status = status;
    if (reviewNotes !== undefined) updates.review_notes = reviewNotes;
    if (reviewReasonCategory !== undefined) updates.review_reason_category = reviewReasonCategory;
    if (markVisitPassed) updates.visit_status = 'passed';

    await this.listings.update({ id }, updates);

    const data = await this.listings.findOne({ where: { id } });
    if (!data) {
      throw new NotFoundException('Listing not found');
    }

    const listingTitle = (data.draft_data as any)?.property_details?.title ?? 'your listing';
    const statusChanged = !!status && status !== previousStatus;
    if (statusChanged && status === 'live') {
      this.notifications.notify('listing.live', data.host_id, {
        listingTitle,
        pushTitle: 'Your listing is live',
        pushBody: `${listingTitle} is now visible to guests on Basera`,
        link: `/host/listings`,
      });
      // Detect source language now, not on the first guest request — a
      // freshly-live listing otherwise pays this latency (and a DB write)
      // on whichever guest happens to load it first.
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

  // --- stats ----------------------------------------------------------------

  async getStats() {
    const [listings, totalUsers] = await Promise.all([
      this.listings.find({ select: { status: true } }),
      this.profiles.count(),
    ]);

    const totalProperties = listings.length;
    const pendingReviews = listings.filter((l) => l.status === 'in_review').length;
    const liveProperties = listings.filter((l) => l.status === 'live').length;
    const changesNeeded = listings.filter((l) => l.status === 'changes_needed').length;
    const draftProperties = listings.filter((l) => l.status === 'draft').length;

    return {
      stats: {
        totalProperties,
        pendingReviews,
        liveProperties,
        changesNeeded,
        draftProperties,
        totalUsers,
        telemetryGpsAccuracy: '99.8%',
      },
    };
  }

  // --- users ------------------------------------------------------------

  async getUsers(roleParam?: string, q?: string) {
    const query = q?.toLowerCase();

    const profiles = await this.profiles.find({ order: { created_at: 'DESC' } });
    const listingCounts = await this.listings.find({ select: { host_id: true } });

    const countMap = new Map<string, number>();
    for (const l of listingCounts) {
      if (l.host_id) countMap.set(l.host_id, (countMap.get(l.host_id) || 0) + 1);
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
        kycStatus: (p.kyc_completed_at ? 'verified' : 'not_submitted') as
          | 'verified'
          | 'in_review'
          | 'not_submitted',
      };
    });

    if (roleParam && roleParam !== 'all') {
      users = users.filter((u) =>
        roleParam === 'host' ? u.isHost : roleParam === 'admin' ? u.isAdmin : !u.isHost && !u.isAdmin,
      );
    }

    if (query) {
      users = users.filter(
        (u) =>
          u.name.toLowerCase().includes(query) ||
          u.email.toLowerCase().includes(query) ||
          (u.phone && u.phone.toLowerCase().includes(query)),
      );
    }

    const allUsers = profiles.map((p) => ({ isHost: resolveIsHost(p), isAdmin: resolveIsAdmin(p) }));
    const counts = {
      all: allUsers.length,
      hosts: allUsers.filter((u) => u.isHost).length,
      guests: allUsers.filter((u) => !u.isHost && !u.isAdmin).length,
      admins: allUsers.filter((u) => u.isAdmin).length,
    };

    return { users, counts, total: users.length };
  }

  // --- user isHost toggle -------------------------------------------------

  /**
   * Toggles host capability on an account. That is the whole surface.
   * trust_tier / trust_score / status are deliberately never written here —
   * see users/[id]/route.ts's comment: none of those columns exist on the
   * original profiles table, and re-adding trust_tier/trust_score would give
   * the one figure the product rests on two competing sources of truth.
   * Admin is not settable here or anywhere else — manually provisioned via
   * direct SQL only.
   */
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

  // --- payments / disputes / subscriptions --------------------------------

  /** Ops-facing payments ledger, filterable by status. */
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

  /** Every disputed booking's case — `open`/`negotiating` show read-only
   *  (still between guest and host, admin can peek but shouldn't be
   *  tempted to short-circuit negotiation), `escalated` is the actionable
   *  queue, `appealed` needs a final look. */
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

  /** Full case detail for the admin's case-review view — claim, evidence,
   *  and the whole negotiation/decision timeline, not just the isolated
   *  claim text `getDisputes` summarizes for the list. */
  async getDisputeCase(bookingId: string, adminUserId: string) {
    return this.bookingsService.getDisputeCase(adminUserId, bookingId);
  }

  /** Admin resolution of an escalated case, for any amount to the guest —
   *  0 or the full paid amount reproduces the old binary refund/release. */
  async resolveDispute(bookingId: string, adminUserId: string, amountToGuest: unknown, message: unknown) {
    if (typeof amountToGuest !== 'number' || !Number.isInteger(amountToGuest) || amountToGuest < 0) {
      throw new BadRequestException('amountToGuest must be a non-negative integer');
    }
    if (message !== undefined && typeof message !== 'string') {
      throw new BadRequestException('message must be a string');
    }
    return this.bookingsService.resolveDispute(adminUserId, bookingId, amountToGuest, message);
  }

  /** Final say after one appeal — same validation shape as resolveDispute. */
  async resolveAppeal(bookingId: string, adminUserId: string, amountToGuest: unknown, message: unknown) {
    if (typeof amountToGuest !== 'number' || !Number.isInteger(amountToGuest) || amountToGuest < 0) {
      throw new BadRequestException('amountToGuest must be a non-negative integer');
    }
    if (message !== undefined && typeof message !== 'string') {
      throw new BadRequestException('message must be a string');
    }
    return this.bookingsService.resolveAppeal(adminUserId, bookingId, amountToGuest, message);
  }

  /** Ops visibility into who's on what plan/status. */
  async getSubscriptions() {
    const rows = await this.subscriptions.find({ order: { updated_at: 'DESC' } });
    const hostIds = Array.from(new Set(rows.map((r) => r.host_id)));
    const profiles = hostIds.length
      ? await this.profiles.find({ where: hostIds.map((id) => ({ id })), select: { id: true, full_name: true } })
      : [];
    const nameById = new Map(profiles.map((p) => [p.id, p.full_name ?? 'Basera user']));

    const subscriptions = rows.map((row) => ({
      id: row.id,
      hostId: row.host_id,
      hostName: nameById.get(row.host_id) ?? 'Basera user',
      planId: row.plan_id,
      status: row.status,
      amount: row.amount,
      currentPeriodStart: row.current_period_start,
      currentPeriodEnd: row.current_period_end,
    }));

    return { subscriptions, total: subscriptions.length };
  }

  // --- verification requests ----------------------------------------------

  /**
   * Full detail for one verification request: everything in the list view
   * plus the raw analysis_result, a short-lived signed document URL (via
   * StorageService — omitted when there is no document, e.g. some bank
   * submissions), the relevant profile fields for cross-check, the user's
   * older attempts at the same verification_type (resubmission history,
   * most recent first), and the full audit-log trail for this request.
   */
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
        bank_upi: true,
        bank_account_name: true,
        registration_number: true,
        pan: true,
      },
    });
    const profileById = new Map(profiles.map((p) => [p.id, p]));
    const submitterProfile = profileById.get(row.user_id);

    let documentUrl: string | null = null;
    if (row.document_path) {
      documentUrl = await this.storage.createSignedDownloadUrl('verification-documents', row.document_path, 300);
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
      bank:
        row.verification_type === 'bank'
          ? {
              accountNumber: row.bank_account_number,
              ifsc: row.bank_ifsc,
              accountHolderName: row.bank_account_holder_name,
              bankName: row.bank_name,
              // Existing profile fields, for the admin to cross-check the
              // new submission against what's already on file.
              profileBankUpi: submitterProfile?.bank_upi ?? null,
              profileBankAccountName: submitterProfile?.bank_account_name ?? null,
            }
          : undefined,
      legal:
        row.verification_type === 'legal'
          ? {
              registrationNumber: row.registration_number,
              // Existing self-attested profile fields, for cross-check —
              // same idea as bank's profileBankUpi/profileBankAccountName.
              profileRegistrationNumber: submitterProfile?.registration_number ?? null,
              profilePan: submitterProfile?.pan ?? null,
            }
          : undefined,
      previousAttempts,
      auditLog,
    };
  }

  /**
   * Admin approve/reject decision on a verification request. Server-side
   * state machine: only a `pending` request can be reviewed here —
   * verified/rejected are terminal from this endpoint, the only way back to
   * pending is the user resubmitting (which creates a new row, never
   * mutates this one). rejectionReason is required on reject.
   *
   * On approve of identity/pan: profiles has no dedicated "identity
   * verified"/"pan verified" column, and none is invented here — the
   * verification_requests row itself (status=verified) is the source of
   * truth for that concept; assertVerified() does not gate on
   * identity/pan today, so nothing else needs to change for those two
   * types to reflect approval.
   *
   * On approve of bank: profiles.bank_verified_at is set to now() because
   * assertVerified() gates on exactly that column — approving a bank
   * request must actually flip the gate the user-facing app already
   * checks. profiles.bank_account_name is overwritten with the submitted
   * holder name (the same column the old client-only heuristic check
   * wrote to), so the profile reflects the newly-verified identity.
   * profiles.bank_upi is intentionally left untouched: the new bank
   * verification flow collects accountNumber+IFSC, not a UPI id, so there
   * is nothing here to write into bank_upi — it stays whatever the user
   * separately set it to (or null), and is surfaced read-only in
   * getVerificationRequestDetail for cross-check instead.
   */
  async reviewVerificationRequest(id: string, adminId: string, body: unknown) {
    const parsed = verificationReviewSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'Invalid review payload');
    }
    const { decision, rejectionReason } = parsed.data;

    const row = await this.verificationRequests.findOne({ where: { id } });
    if (!row) {
      throw new NotFoundException('Verification request not found');
    }
    if (row.status !== 'pending') {
      throw new ConflictException(
        `This request has already been reviewed (status: ${row.status}). Only pending requests can be reviewed.`,
      );
    }

    const newStatus = decision === 'approve' ? 'verified' : 'rejected';
    const now = new Date();

    await this.verificationRequests.update(
      { id },
      {
        status: newStatus,
        reviewed_by: adminId,
        reviewed_at: now,
        rejection_reason: decision === 'reject' ? rejectionReason! : null,
        updated_at: now,
      },
    );

    if (decision === 'approve' && row.verification_type === 'bank') {
      await this.profiles.update(
        { id: row.user_id },
        {
          bank_verified_at: now,
          bank_account_name: row.bank_account_holder_name ?? undefined,
        },
      );
    }

    // On approve of legal: profiles.registration_number and
    // kyc_completed_at are the columns assertVerified()'s requireHostKyc
    // branch and host-listings' submit gate already read — approving this
    // request must actually flip them, same reasoning as bank above. This
    // is what moves the HP Tourism certificate off the old
    // instant-self-attest POST /api/user/kyc path onto real admin review.
    if (decision === 'approve' && row.verification_type === 'legal') {
      await this.profiles.update(
        { id: row.user_id },
        {
          registration_number: row.registration_number ?? undefined,
          kyc_completed_at: now,
        },
      );
    }

    // On approve of selfie: profiles.selfie_uploaded_at is what
    // assertVerified() actually gates on. The new flow uploads straight to
    // verification_requests.document_path (not the old
    // signed-URL-then-POST-/api/user/verification/selfie path), so nothing
    // else sets this column for a submission reviewed through here —
    // approval is what makes it real, same reasoning as bank/legal above.
    // profiles.selfie_url is intentionally left as whatever the old flow
    // set it to (or null): the reviewed photo lives in document_path /
    // the private verification-documents bucket, not duplicated there.
    if (decision === 'approve' && row.verification_type === 'selfie') {
      await this.profiles.update({ id: row.user_id }, { selfie_uploaded_at: now });
    }

    await this.verificationAuditLog.save(
      this.verificationAuditLog.create({
        verification_request_id: id,
        user_id: row.user_id,
        admin_id: adminId,
        action: decision === 'approve' ? 'approved' : 'rejected',
        previous_status: 'pending',
        new_status: newStatus,
        rejection_reason: decision === 'reject' ? rejectionReason : null,
      }),
    );

    const layerName = VERIFICATION_LAYER_NAME[row.verification_type] ?? row.verification_type;
    if (decision === 'approve') {
      this.notifications.notify('verification.layer_passed', row.user_id, {
        layerName,
        pushTitle: `${layerName} verification passed`,
        pushBody: `Your ${layerName} verification was approved`,
        link: '/account',
      });
    } else {
      this.notifications.notify('verification.layer_failed', row.user_id, {
        layerName,
        failReason: rejectionReason,
        pushTitle: `${layerName} verification needs another look`,
        pushBody: rejectionReason,
        link: '/account',
      });
    }

    const updated = await this.verificationRequests.findOne({ where: { id } });
    return { success: true, request: updated };
  }

  /**
   * Admin document access — same signed-URL mechanism as the user-facing
   * route but WITHOUT an ownership check, since AdminGuard already gates
   * the whole controller and an admin is allowed to view any user's
   * document. Still a short-lived signed URL, never getPublicUrl().
   */
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

  /**
   * All of one user's verification requests, grouped by type — the data
   * behind UserDetailModal's "Verification" section. Replaces the old
   * standalone cross-user "Verification" admin tab: reviewing verification
   * is now something an admin does from a user's own profile, not from a
   * separate global queue. For each of the 5 verification_type values,
   * returns the most recent row (the "current" one — same convention as
   * VerificationService.getMyStatus on the user side) plus any older rows
   * as resubmission history, so nothing about a user's status/history is
   * lost by dropping the flat table view.
   */
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
