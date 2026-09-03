import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { z } from 'zod';
import {
  ListingEntity,
  ProfileEntity,
  BookingEntity,
  NotificationLogEntity,
  PaymentEntity,
  HostSubscriptionEntity,
} from '../entities';
import { NotificationsService } from '../notifications/notifications.service';
import { ListingTranslationService } from '../listings/listing-translation.service';
import { BookingsService } from '../bookings/bookings.service';

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
    @InjectRepository(ProfileEntity) private readonly profiles: Repository<ProfileEntity>,
    @InjectRepository(BookingEntity) private readonly bookings: Repository<BookingEntity>,
    @InjectRepository(NotificationLogEntity) private readonly notificationLog: Repository<NotificationLogEntity>,
    @InjectRepository(PaymentEntity) private readonly payments: Repository<PaymentEntity>,
    @InjectRepository(HostSubscriptionEntity) private readonly subscriptions: Repository<HostSubscriptionEntity>,
    private readonly notifications: NotificationsService,
    private readonly listingTranslations: ListingTranslationService,
    private readonly bookingsService: BookingsService,
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

      const profile = profileMap.get(row.host_id) || ({} as Partial<ProfileEntity>);

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

      const photos: string[] =
        draft.photos && draft.photos.length > 0
          ? draft.photos
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
            videoUrl: telemetryStep.videoUrl,
            gpsMatched: telemetryStep.gpsMatched ?? false,
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

  /** Open disputes queue — the only way a `disputed` booking gets resolved. */
  async getDisputes() {
    const rows = await this.bookings.find({ where: { status: 'disputed' }, order: { updated_at: 'DESC' } });
    if (rows.length === 0) {
      return { disputes: [], total: 0 };
    }

    const listingIds = Array.from(new Set(rows.map((r) => r.listing_id)));
    const partyIds = Array.from(new Set(rows.flatMap((r) => [r.guest_id, r.host_id])));

    const [listingRows, profileRows, paymentRows] = await Promise.all([
      this.listings.find({ where: listingIds.map((id) => ({ id })), select: { id: true, draft_data: true } }),
      this.profiles.find({ where: partyIds.map((id) => ({ id })), select: { id: true, full_name: true } }),
      this.payments.find({ where: rows.map((r) => ({ booking_id: r.id })) }),
    ]);

    const titleById = new Map(
      listingRows.map((l) => [l.id, (l.draft_data as any)?.property_details?.title ?? 'Listing']),
    );
    const nameById = new Map(profileRows.map((p) => [p.id, p.full_name ?? 'Basera user']));
    const paymentByBookingId = new Map(paymentRows.map((p) => [p.booking_id, p]));

    const disputes = rows.map((row) => ({
      bookingId: row.id,
      listingId: row.listing_id,
      listingTitle: titleById.get(row.listing_id) ?? 'Listing',
      guestName: nameById.get(row.guest_id) ?? 'Basera user',
      hostName: nameById.get(row.host_id) ?? 'Basera user',
      reason: row.rejection_reason,
      amount: paymentByBookingId.get(row.id)?.amount ?? row.due_at_move_in,
      checkinTime: row.checkin_time,
      updatedAt: row.updated_at,
    }));

    return { disputes, total: disputes.length };
  }

  /** Resolves a disputed booking: `refund` sides with the guest, `release` sides with the host. */
  async resolveDispute(bookingId: string, adminUserId: string, resolution: unknown) {
    if (resolution !== 'refund' && resolution !== 'release') {
      throw new BadRequestException('resolution must be "refund" or "release"');
    }
    return this.bookingsService.resolveDispute(adminUserId, bookingId, resolution);
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
}
