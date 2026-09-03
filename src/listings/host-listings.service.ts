import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ListingEntity, ProfileEntity } from '../entities';
import { assertVerified } from '../user/verification-gate.util';
import {
  bankingSchema,
  fullOnboardingSchema,
  listingSchema,
  planSchema,
  telemetrySchema,
} from './listing-schema';

/** Statuses a host may resubmit from. `live`/`paused` are edited through a
 *  separate flow (not yet built) since they are already public; `in_review`
 *  is already in the queue. */
const EDITABLE_STATUSES = ['draft', 'changes_needed', 'rejected'];

export type HostListingSummary = {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string | null;
  title: string;
  town: string;
  fullAddress: string;
  price: number | null;
  beds: string;
  bedrooms: number | null;
  bathrooms: number | null;
  maxGuests: number | null;
  minMonths: number | null;
  propertyType: string;
  photoCount: number;
  plan: string | null;
  reviewNotes: string | null;
  reviewReasonCategory: string | null;
};

/**
 * Host-facing listing management. Ported from web/app/api/host/listings/
 * route.ts, .../[id]/route.ts and .../submit-full/route.ts.
 */
@Injectable()
export class HostListingsService {
  constructor(
    @InjectRepository(ListingEntity)
    private readonly listings: Repository<ListingEntity>,
    @InjectRepository(ProfileEntity)
    private readonly profiles: Repository<ProfileEntity>,
  ) {}

  /** The caller's own listings, scoped by the session's user id — a host can
   *  never read someone else's rows through this method. Rows are flattened
   *  into a stable shape rather than handing back raw `draft_data`: every
   *  consumer digging into that JSON itself is what left the dashboard
   *  reading `draft.property` after the key became `property_details`,
   *  silently falling back to sample data. */
  async findMine(userId: string): Promise<HostListingSummary[]> {
    const rows = await this.listings.find({
      where: { host_id: userId },
      order: { created_at: 'DESC' },
    });

    return rows.map((row) => {
      const draft = (row.draft_data as Record<string, any>) ?? {};
      // `property_details` is the current key; `property`/`basics` are read
      // as a fallback for rows written by the superseded per-step funnel.
      const prop = draft.property_details ?? draft.property ?? draft.basics ?? {};
      return {
        id: row.id,
        status: row.status,
        createdAt:
          row.created_at instanceof Date ? row.created_at.toISOString() : (row.created_at as unknown as string),
        updatedAt: row.updated_at
          ? row.updated_at instanceof Date
            ? row.updated_at.toISOString()
            : (row.updated_at as unknown as string)
          : null,
        title: prop.title ?? '',
        town: prop.town ?? '',
        fullAddress: prop.fullAddress ?? '',
        price: typeof prop.price === 'number' ? prop.price : null,
        beds: prop.beds ?? '',
        bedrooms: prop.bedrooms ?? null,
        bathrooms: prop.bathrooms ?? null,
        maxGuests: prop.maxGuests ?? null,
        minMonths: prop.minMonths ?? null,
        propertyType: prop.propertyType ?? '',
        photoCount: prop.photoCount ?? 0,
        plan: draft.plan?.plan ?? null,
        // Only meaningful for changes_needed/rejected — what the host would
        // otherwise have no way to learn.
        reviewNotes: row.review_notes ?? null,
        reviewReasonCategory: row.review_reason_category ?? null,
      };
    });
  }

  /** A single listing the caller owns, flattened the same way findMine is,
   *  for prefilling the edit form. */
  async findMineById(userId: string, id: string) {
    const row = await this.listings.findOne({ where: { id, host_id: userId } });
    if (!row) {
      throw new NotFoundException('Listing not found');
    }

    const draft = (row.draft_data as Record<string, any>) ?? {};

    return {
      id: row.id,
      status: row.status,
      reviewNotes: row.review_notes ?? null,
      reviewReasonCategory: row.review_reason_category ?? null,
      draft: {
        ...(draft.property_details ?? draft.property ?? draft.basics ?? {}),
        ...(draft.telemetry ?? {}),
        ...(draft.banking ?? {}),
        ...(draft.plan ?? {}),
      },
    };
  }

  /**
   * Lets a host fix a `changes_needed` (or `rejected`) listing and send it
   * back for review. Overwrites `property_details`/telemetry/banking/plan
   * the same way submitFull builds them, then moves the row back to
   * `in_review` and clears the old review note — a stale "changes needed"
   * reason must not linger once the host has acted on it.
   *
   * Identity/legal/host-type still come from the verified profile, never the
   * request body, for the same reason submitFull does that.
   */
  async resubmit(userId: string, id: string, body: unknown) {
    const existing = await this.listings.findOne({
      where: { id, host_id: userId },
    });
    if (!existing) {
      throw new NotFoundException('Listing not found');
    }

    if (!EDITABLE_STATUSES.includes(existing.status)) {
      throw new ConflictException('This listing cannot be edited right now.');
    }

    const parsed = fullOnboardingSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues[0]?.message ?? 'Check the details entered.',
      );
    }
    const d = parsed.data;

    const priorDraft = (existing.draft_data as Record<string, any>) ?? {};
    const draft_data = {
      ...priorDraft,
      property_details: listingSchema.parse(d),
      telemetry: telemetrySchema.parse(d),
      banking: bankingSchema.parse(d),
      plan: planSchema.parse(d),
    };

    existing.draft_data = draft_data;
    existing.status = 'in_review';
    existing.review_notes = null;
    existing.review_reason_category = null;
    existing.updated_at = new Date();

    const saved = await this.listings.save(existing);

    return { listingId: saved.id, status: 'in_review' as const };
  }

  /**
   * The single write for the one-page listing form. Identity/legal/host-type
   * are NOT read from the request body — they are account-level facts on
   * `profiles`, verified once from Account & Profile. Taking them from the
   * row rather than the client is what stops a caller claiming a PAN or
   * registration number that was never verified.
   *
   * `draft_data` keeps the shape the old per-step PATCHes built up, because
   * the read paths (listings.service.ts, admin properties, public listings)
   * key off draft.property_details / draft.kind / etc. and must not need to
   * change.
   */
  async submitFull(userId: string, body: unknown) {
    const profile = await this.profiles.findOne({ where: { id: userId } });
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }

    assertVerified(profile, { requireHostKyc: true });

    const parsed = fullOnboardingSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues[0]?.message ?? 'Check the details entered.',
      );
    }
    const d = parsed.data;

    const draft_data = {
      // From the verified profile, never from the request body.
      kind: { host_kind: profile.host_kind },
      identity: { pan: profile.pan, gst: profile.gst ?? '' },
      legal: { registrationNumber: profile.registration_number },
      // From this submission.
      property_details: listingSchema.parse(d),
      telemetry: telemetrySchema.parse(d),
      banking: bankingSchema.parse(d),
      plan: planSchema.parse(d),
    };

    const created = this.listings.create({
      host_id: userId,
      status: 'in_review',
      draft_data,
    });
    const saved = await this.listings.save(created);

    return { listingId: saved.id, status: 'in_review' as const };
  }
}
