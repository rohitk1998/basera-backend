import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createReadStream } from 'fs';
import { unlink } from 'fs/promises';
import { randomUUID } from 'crypto';
import { ListingEntity, UserEntity } from '../entities';
import { assertVerified } from '../user/verification-gate.util';
import { SupabaseProvider } from '../auth/supabase.provider';
import {
  bankingSchema,
  fullOnboardingSchema,
  listingSchema,
  mediaSchema,
  planSchema,
  telemetrySchema,
  ROOM_IDS,
} from './listing-schema';

type UploadedMulterFile = { buffer?: Buffer; path?: string; mimetype: string; size: number };

const PHOTO_ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const PHOTO_MAX_BYTES = 8 * 1024 * 1024;

const VIDEO_ALLOWED_TYPES: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};
const VIDEO_MAX_BYTES = 150 * 1024 * 1024;

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
  dailyBaseRate: number | null;
  beds: string;
  bedrooms: number | null;
  bathrooms: number | null;
  maxGuests: number | null;
  minDays: number | null;
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
    @InjectRepository(UserEntity)
    private readonly profiles: Repository<UserEntity>,
    private readonly supabase: SupabaseProvider,
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
        dailyBaseRate: typeof prop.dailyBaseRate === 'number' ? prop.dailyBaseRate : null,
        beds: prop.beds ?? '',
        bedrooms: prop.bedrooms ?? null,
        bathrooms: prop.bathrooms ?? null,
        maxGuests: prop.maxGuests ?? null,
        minDays: prop.minDays ?? null,
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

  /**
   * Keyed off the host only, not a listing — the wizard is a one-page form
   * with no listing row until final submit (see submitFull), so photos
   * upload to the host's own storage folder first and the returned URLs
   * ride along in the submit-full/resubmit body afterward, same shape as
   * every other wizard field. Room tags come from the host, paired
   * atomically with each URL rather than a parallel array, so there is no
   * index-drift risk between a photo and its tag.
   */
  async uploadPhotos(userId: string, files: UploadedMulterFile[], rooms: string[]) {
    if (files.length !== rooms.length) {
      throw new BadRequestException('Each file must have exactly one room tag.');
    }
    for (const room of rooms) {
      if (!(ROOM_IDS as readonly string[]).includes(room)) {
        throw new BadRequestException(`Invalid room tag: ${room}`);
      }
    }

    const photos: { url: string; room: string }[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const ext = PHOTO_ALLOWED_TYPES[file.mimetype];
      if (!ext) {
        throw new BadRequestException('Unsupported file type. Use JPEG, PNG or WebP.');
      }
      if (file.size > PHOTO_MAX_BYTES) {
        throw new BadRequestException({ error: 'File too large. Maximum size is 8 MB.', statusCode: 413 });
      }
      if (!file.buffer) {
        throw new InternalServerErrorException('Photo upload expected an in-memory file.');
      }

      const storagePath = `${userId}/photos/${randomUUID()}.${ext}`;
      const { error: uploadError } = await this.supabase.client.storage
        .from('listing-media')
        .upload(storagePath, file.buffer, { contentType: file.mimetype });
      if (uploadError) {
        throw new InternalServerErrorException('Upload failed. Please try again.');
      }

      const {
        data: { publicUrl },
      } = this.supabase.client.storage.from('listing-media').getPublicUrl(storagePath);
      photos.push({ url: publicUrl, room: rooms[i] });
    }

    return photos;
  }

  /**
   * A short property video, no transcoding — stored and served as-is.
   * Uses Multer's disk storage (see host-listings.controller.ts's
   * FileInterceptor options) rather than the in-memory buffering every
   * other upload in this codebase uses: a 150MB cap held fully in RAM per
   * concurrent request is a real resource risk at this size, unlike the
   * ~5-30MB avatar/dispute-evidence uploads. The temp file is always
   * removed, success or failure.
   */
  async uploadVideo(userId: string, file: UploadedMulterFile) {
    const ext = VIDEO_ALLOWED_TYPES[file.mimetype];
    if (!ext) {
      throw new BadRequestException('Unsupported file type. Use MP4, WebM or MOV.');
    }
    if (file.size > VIDEO_MAX_BYTES) {
      throw new BadRequestException({ error: 'File too large. Maximum size is 150 MB.', statusCode: 413 });
    }
    if (!file.path) {
      throw new InternalServerErrorException('Video upload expected a temp file on disk.');
    }

    try {
      const storagePath = `${userId}/video/${randomUUID()}.${ext}`;
      const { error: uploadError } = await this.supabase.client.storage
        .from('listing-media')
        .upload(storagePath, createReadStream(file.path), { contentType: file.mimetype, duplex: 'half' });
      if (uploadError) {
        throw new InternalServerErrorException('Upload failed. Please try again.');
      }

      const {
        data: { publicUrl },
      } = this.supabase.client.storage.from('listing-media').getPublicUrl(storagePath);
      return publicUrl;
    } finally {
      await unlink(file.path).catch(() => {});
    }
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
        ...(draft.media ?? {}),
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
      media: mediaSchema.parse(d),
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
      media: mediaSchema.parse(d),
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
