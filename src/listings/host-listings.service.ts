import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  Optional,
  NotFoundException,
  OnModuleDestroy,
  PayloadTooLargeException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { assertLocationIsValid, upgradeLegacyLocation } from './location.util';
import { createReadStream } from 'fs';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { ExifTool, type Tags } from 'exiftool-vendored';
import { ListingEntity, UserEntity } from '../entities';
import { assertKycVerified } from '../user/verification-gate.util';
import { CaptureConfigService } from './capture-config.service';
import { SupabaseProvider } from '../auth/supabase.provider';
import { RedisService } from '../redis/redis.service';
import { VerificationService } from '../verification/verification.service';
import { SEARCH_CACHE_VERSION_KEY } from './listings.service';
import {
  assessWalkthroughMetadata,
  distanceMetres,
  formatDistance,
  WALKTHROUGH_GPS_TOLERANCE_METRES,
  WALKTHROUGH_MIN_DURATION_SECONDS,
  type WalkthroughCheckRecord,
} from './walkthrough-gps.util';
import {
  assessCapture,
  bypassedCaptureRecord,
  isCaptureRecord,
  isWithinTolerance,
  parseCaptureClaim,
  withDistanceFrom,
  type CaptureRecord,
} from './capture.util';

/** TTL for a walkthrough-check token (see verifyWalkthroughVideo /
 *  readWalkthroughToken below) — long enough to cover filling in the rest
 *  of the one-page form after checking the video, short enough that a token
 *  can't be banked and reused across unrelated sessions/listings. */
const WALKTHROUGH_TOKEN_TTL_SECONDS = 60 * 60;

function walkthroughTokenKey(userId: string, token: string): string {
  return `walkthrough-token:${userId}:${token}`;
}

/** How long a photo's capture receipt (see uploadPhotos) stays redeemable at
 *  submit / save-draft. Long enough to finish a long form, and for a failed
 *  submit to be retried the same day. Once a listing is saved the receipt's
 *  contents live in `draft_data.captures`, so this only bounds the time between
 *  taking a photo and first saving it with a listing. */
const CAPTURE_RECEIPT_TTL_SECONDS = 24 * 60 * 60;

function captureReceiptKey(userId: string, url: string): string {
  return `capture-receipt:${userId}:${createHash('sha256').update(url).digest('hex')}`;
}
import {
  fullOnboardingSchema,
  listingSchema,
  mediaSchema,
  photoSchema,
  telemetrySchema,
  toFullAddress,
  ROOM_IDS,
} from './listing-schema';
import { z } from 'zod';

/** A draft is allowed to hold fewer than the 5 photos a submit needs: photos
 *  are uploaded the moment they are captured, so a host who saves and exits
 *  after the first one or two has a short list. The minimum applies at submit. */
const draftPropertySchema = listingSchema.partial().extend({ photos: z.array(photoSchema).optional() });
const draftSchema = fullOnboardingSchema.partial().extend({ photos: z.array(photoSchema).optional() });

type UploadedMulterFile = {
  buffer?: Buffer;
  path?: string;
  mimetype: string;
  size: number;
};

/** Listing photos are only accepted as JPEG: that is what the in-app camera
 *  produces (canvas -> JPEG), and it is the one format whose metadata we
 *  strip with certainty on the way in. */
const PHOTO_ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
};
const PHOTO_MAX_BYTES = 8 * 1024 * 1024;

const VIDEO_ALLOWED_TYPES: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

/** MediaRecorder reports types like `video/webm;codecs=vp9,opus`. */
const baseMimeType = (mimetype: string) => mimetype.split(';')[0].trim().toLowerCase();

/** A recording longer than this is not a walkthrough, whatever the client says. */
const MAX_CLIENT_DURATION_SECONDS = 60 * 60;

const CAPTURE_REQUIRED_MESSAGE =
  'Photos and the walkthrough video must be taken with the in-app camera. Remove this one and capture it again.';
const VIDEO_MAX_BYTES = 150 * 1024 * 1024;

/** Statuses a host may resubmit from. `live` is included: editing a public
 *  listing pulls it from search immediately (resubmit sets status to
 *  in_review, and every public query filters on status = 'live' — see
 *  listings.service.ts findLive), same as a brand-new submission, so a
 *  guest never sees a listing whose data the host is mid-changing. `paused`
 *  is a host-initiated "off the market" state with its own separate flow
 *  (not yet built) — a host has to un-pause deliberately, not by editing.
 *  `in_review` is excluded on purpose: a listing already queued for review
 *  must not be edited out from under the reviewer looking at it. */
const EDITABLE_STATUSES = ['draft', 'changes_needed', 'rejected', 'live'];

export type HostListingSummary = {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string | null;
  title: string;
  town: string;
  fullAddress: string;
  dailyBaseRate: number | null;
  weeklyDiscountPct: number | null;
  monthlyDiscountPct: number | null;
  beds: string;
  bedrooms: number | null;
  bathrooms: number | null;
  maxGuests: number | null;
  minDays: number | null;
  propertyType: string;
  photoCount: number;
  coverPhotoUrl: string | null;
  reviewNotes: string | null;
  reviewReasonCategory: string | null;
};

/**
 * Host-facing listing management. Ported from web/app/api/host/listings/
 * route.ts, .../[id]/route.ts and .../submit-full/route.ts.
 */
@Injectable()
export class HostListingsService implements OnModuleDestroy {
  private readonly logger = new Logger(HostListingsService.name);

  /** Reads the walkthrough file's metadata. Its own instance, with tight
   *  limits, rather than the library's shared one: the defaults wait 30s for a
   *  read, retry it once, and wait another 30s to start a process — a stuck
   *  ExifTool then holds the host's request for a minute or more with no
   *  answer. Timezone inference is switched off because it loads a
   *  geographic dataset for a value nothing here uses. */
  private readonly exif = new ExifTool({
    maxProcs: 2,
    taskTimeoutMillis: 15_000,
    taskRetries: 0,
    spawnTimeoutMillis: 10_000,
    backfillTimezones: false,
    inferTimezoneFromDatestamps: false,
    inferTimezoneFromTimeStamp: false,
  });

  async onModuleDestroy() {
    await this.exif.end().catch(() => {});
  }

  constructor(
    @InjectRepository(ListingEntity)
    private readonly listings: Repository<ListingEntity>,
    @InjectRepository(UserEntity)
    private readonly profiles: Repository<UserEntity>,
    private readonly supabase: SupabaseProvider,
    private readonly redis: RedisService,
    private readonly verification: VerificationService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    // Optional so a context without it (older specs) behaves as bypass OFF.
    @Optional() private readonly captureConfig?: CaptureConfigService,
  ) {}

  /** TEST ONLY switch (CAPTURE_LOCATION_BYPASS); server-side, never from a client. */
  get locationBypass(): boolean {
    return this.captureConfig?.locationBypass === true;
  }

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
      const prop =
        draft.property_details ?? draft.property ?? draft.basics ?? {};
      return {
        id: row.id,
        status: row.status,
        createdAt:
          row.created_at instanceof Date
            ? row.created_at.toISOString()
            : (row.created_at as unknown as string),
        updatedAt: row.updated_at
          ? row.updated_at instanceof Date
            ? row.updated_at.toISOString()
            : (row.updated_at as unknown as string)
          : null,
        title: prop.title ?? '',
        // `town` is the tehsil on every form-submitted listing; the fallbacks
        // cover rows written before that, so a live listing is not shown as
        // "Location not set" while its address is on file.
        town: prop.town || prop.tehsil || prop.city || '',
        fullAddress: prop.streetAddress
          ? toFullAddress(prop)
          : (prop.fullAddress ?? ''),
        dailyBaseRate:
          typeof prop.dailyBaseRate === 'number' ? prop.dailyBaseRate : null,
        weeklyDiscountPct:
          typeof prop.weeklyDiscountPct === 'number' ? prop.weeklyDiscountPct : null,
        monthlyDiscountPct:
          typeof prop.monthlyDiscountPct === 'number' ? prop.monthlyDiscountPct : null,
        beds: prop.beds ?? '',
        bedrooms: prop.bedrooms ?? null,
        bathrooms: prop.bathrooms ?? null,
        maxGuests: prop.maxGuests ?? null,
        minDays: prop.minDays ?? null,
        propertyType: prop.propertyType ?? '',
        photoCount: prop.photoCount ?? (Array.isArray(prop.photos) ? prop.photos.length : 0),
        coverPhotoUrl: prop.photos?.[0]?.url ?? null,
        // Only meaningful for changes_needed/rejected — what the host would
        // otherwise have no way to learn.
        reviewNotes: row.review_notes ?? null,
        reviewReasonCategory: row.review_reason_category ?? null,
      };
    });
  }

  /**
   * Listing photos. Keyed off the host only, not a listing — the wizard is a
   * one-page form with no listing row until final submit (see submitFull), so
   * photos upload to the host's own storage folder first and the returned URLs
   * ride along in the submit-full/resubmit body afterward, same shape as every
   * other wizard field. Room tags come from the host, paired atomically with
   * each URL rather than a parallel array, so there is no index-drift risk
   * between a photo and its tag.
   *
   * Every photo must have been captured with the in-app camera: each file comes
   * with the device-reported location and time of capture (`captures`, parallel
   * to `files`), checked here against the listing pin (capture.util.ts). All
   * captures are validated before anything is uploaded, so one bad photo does
   * not leave the others orphaned in storage.
   *
   * Two things are written for each stored photo:
   *   - the file itself, with ALL embedded metadata (EXIF / GPS / XMP / IPTC)
   *     removed — photos are public, and an in-app capture has no use for
   *     them. Done with ExifTool (already a dependency, used for the
   *     walkthrough check);
   *   - a short-lived "capture receipt" in Redis keyed by (host, URL). The
   *     submit later redeems it to learn that THIS URL was captured, and where
   *     — the form only carries URLs, and a URL the client types in is not
   *     evidence of anything (see resolvePhotoCaptures).
   */
  async uploadPhotos(
    userId: string,
    files: UploadedMulterFile[],
    rooms: string[],
    pin: { lat: number; lng: number } | undefined,
    captures: unknown,
  ) {
    if (files.length !== rooms.length) {
      throw new BadRequestException(
        'Each file must have exactly one room tag.',
      );
    }
    for (const room of rooms) {
      if (!(ROOM_IDS as readonly string[]).includes(room)) {
        throw new BadRequestException(`Invalid room tag: ${room}`);
      }
    }
    if (!Array.isArray(captures) || captures.length !== files.length) {
      throw new BadRequestException(CAPTURE_REQUIRED_MESSAGE);
    }

    const label = (i: number) => (files.length > 1 ? `Photo ${i + 1}: ` : '');
    const records: CaptureRecord[] = captures.map((raw, i) => {
      if (this.locationBypass) return bypassedCaptureRecord('photo', pin, raw);
      if (!pin) throw new BadRequestException('Drop the pin on the map before taking photos.');
      const claim = parseCaptureClaim(raw);
      if (!claim.ok) throw new BadRequestException(label(i) + claim.reason);
      const assessed = assessCapture(claim.claim, pin, 'photo');
      if (!assessed.ok) throw new BadRequestException(label(i) + assessed.reason);
      return assessed.record;
    });
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!PHOTO_ALLOWED_TYPES[baseMimeType(file.mimetype)]) {
        throw new BadRequestException(label(i) + 'Unsupported file type. Photos must be taken with the in-app camera.');
      }
      if (file.size > PHOTO_MAX_BYTES) {
        throw new PayloadTooLargeException(
          'File too large. Maximum size is 8 MB.',
        );
      }
      if (!file.buffer) {
        throw new InternalServerErrorException(
          'Photo upload expected an in-memory file.',
        );
      }
      // A JPEG starts FF D8 FF. The declared type is the client's word only.
      if (!(file.buffer[0] === 0xff && file.buffer[1] === 0xd8 && file.buffer[2] === 0xff)) {
        throw new BadRequestException(label(i) + 'This file is not a JPEG photo. Take the photo with the in-app camera.');
      }
    }

    const photos: { url: string; room: string; capture: Pick<CaptureRecord, 'distanceFromPinM' | 'accuracyM' | 'capturedAt'> }[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const clean = await this.stripImageMetadata(file.buffer!);

      const storagePath = `${userId}/photos/${randomUUID()}.jpg`;
      const { error: uploadError } = await this.supabase.client.storage
        .from('listing-media')
        .upload(storagePath, clean, { contentType: 'image/jpeg' });
      if (uploadError) {
        throw new InternalServerErrorException(
          'Upload failed. Please try again.',
        );
      }

      const {
        data: { publicUrl },
      } = this.supabase.client.storage
        .from('listing-media')
        .getPublicUrl(storagePath);

      // Same retry-once as the walkthrough token: a first failure is usually a
      // stale cache connection. Without the receipt this photo could never be
      // submitted, so do not report success for it.
      const receiptKey = captureReceiptKey(userId, publicUrl);
      const receipt = JSON.stringify(records[i]);
      const saved =
        (await this.redis.set(receiptKey, receipt, CAPTURE_RECEIPT_TTL_SECONDS)) ||
        (await this.redis.set(receiptKey, receipt, CAPTURE_RECEIPT_TTL_SECONDS));
      if (!saved) {
        throw new InternalServerErrorException(
          'We could not save the photo just now. Please capture it again.',
        );
      }

      const { distanceFromPinM, accuracyM, capturedAt } = records[i];
      photos.push({ url: publicUrl, room: rooms[i], capture: { distanceFromPinM, accuracyM, capturedAt } });
    }

    return photos;
  }

  /** Removes every embedded metadata block (EXIF incl. GPS, XMP, IPTC,
   *  comments) from a JPEG. An in-app capture has none, so for the intended
   *  client this is a no-op; it exists so a hand-made request cannot publish a
   *  photo carrying the host's coordinates or device details. Fails closed:
   *  if the file cannot be cleaned it is not stored. */
  private async stripImageMetadata(buffer: Buffer): Promise<Buffer> {
    let dir: string | undefined;
    try {
      dir = await mkdtemp(path.join(os.tmpdir(), 'photo-'));
      const file = path.join(dir, 'photo.jpg');
      await writeFile(file, buffer);
      await this.exif.write(file, {}, ['-all=', '-overwrite_original']);
      return await readFile(file);
    } catch (err) {
      this.logger.warn(`photo metadata strip failed: ${(err as Error).message}`);
      throw new InternalServerErrorException('The photo could not be processed. Please try again.');
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * The walkthrough ("telemetry") check. The video must have been recorded with
   * the in-app camera: it arrives with the device-reported location and time at
   * the end of the recording (`captureRaw`), which is checked against the
   * pinned lat/lng (capture.util.ts) — in Himachal Pradesh, accurate to
   * 100 m or better, fresh, and within the walkthrough tolerance of the pin.
   * The file itself is then given the same cheap sanity checks as before
   * (it has a video picture, a plausible length and was not made by editing
   * software). A GPS tag inside the file is no longer read or required: the
   * browser's MediaRecorder writes none.
   *
   * What a pass means, and does not: the DEVICE says it was near the pin when
   * the recording ended. A modified client or a mock-location app can say
   * that about anywhere, and nothing here looks at the footage. So a pass is
   * "recorded in-app, device-reported location near the pin, needs a person
   * to watch it" (`needsVisualReview`), never "verified", and the outcome
   * travels with the listing (see walkthroughTelemetry) so the reviewer sees
   * exactly that.
   *
   * If the analyser itself is unavailable (timeout, cannot start) the host is
   * not blocked for our fault: the capture location is still checked, and the
   * check passes as `unanalysed`, with no claim about the file, and goes to the
   * reviewer the same way.
   *
   * Length: a MediaRecorder WebM carries no duration in its header (Chrome
   * and Firefox write it as a live stream), so when the container has none the
   * length the browser measured is used instead and the record says so
   * (`durationSource`). Mp4 from Safari carries its own.
   */
  async verifyWalkthroughVideo(
    userId: string,
    file: UploadedMulterFile,
    pinIn: { lat: number; lng: number } | undefined,
    captureRaw: unknown,
    clientDurationSeconds?: number,
  ): Promise<{
    passed: boolean;
    reason?: string;
    method?: WalkthroughCheckRecord['method'];
    needsVisualReview?: boolean;
    warnings?: string[];
    distanceMetres?: number;
    durationSeconds?: number;
    capture?: Pick<CaptureRecord, 'distanceFromPinM' | 'accuracyM' | 'capturedAt'>;
    walkthroughToken?: string;
    walkthroughVideoUrl?: string;
  }> {
    const mimetype = baseMimeType(file.mimetype);
    const ext = VIDEO_ALLOWED_TYPES[mimetype];
    if (!ext) {
      throw new BadRequestException(
        'Unsupported file type. Use MP4, WebM or MOV.',
      );
    }
    if (file.size > VIDEO_MAX_BYTES) {
      throw new PayloadTooLargeException(
        'File too large. Maximum size is 150 MB.',
      );
    }
    if (!file.path) {
      throw new InternalServerErrorException(
        'Video upload expected a temp file on disk.',
      );
    }

    // Once a passed check hands the temp file to the background upload, that
    // upload deletes it; every other path deletes it here.
    let tempFileHandedOff = false;
    try {
      // The capture is checked before the file is opened: it is the cheaper
      // test and the one the host can most often fix by themselves.
      const bypass = this.locationBypass;
      let capture: CaptureRecord;
      if (bypass) {
        // Camera path still required: the client must send a capture object
        // (it may carry no location). Only the location checks are skipped.
        if (!captureRaw || typeof captureRaw !== 'object' || Array.isArray(captureRaw)) {
          return {
            passed: false,
            reason: 'This video has no camera capture details. Record it with the in-app camera.',
          };
        }
        capture = bypassedCaptureRecord('video', pinIn, captureRaw);
      } else {
        if (!pinIn) return { passed: false, reason: 'Drop the pin on the map before recording the video.' };
        const claim = parseCaptureClaim(captureRaw);
        if (!claim.ok) return { passed: false, reason: claim.reason };
        const assessed = assessCapture(claim.claim, pinIn, 'video');
        if (!assessed.ok) return { passed: false, reason: assessed.reason };
        capture = assessed.record;
      }
      const pin = pinIn ?? { lat: capture.lat, lng: capture.lng };

      let check: WalkthroughCheckRecord;
      let durationSeconds: number | undefined;

      let tags: Tags | null = null;
      try {
        tags = await this.exif.read(file.path);
      } catch (err) {
        // A file that is not a video comes back as empty tags (handled below);
        // a throw means the analyser itself failed or timed out.
        this.logger.warn(`walkthrough analysis unavailable: ${(err as Error).message}`);
      }

      if (tags === null) {
        check = {
          method: 'unanalysed',
          visuallyVerified: false,
          capture,
          warnings: ['Automatic analysis was unavailable, so nothing in the file was checked.'],
          checkedAt: new Date().toISOString(),
          ...(bypass ? { bypassed: true as const } : {}),
        };
      } else {
        const fromFile =
          typeof tags.Duration === 'number'
            ? tags.Duration
            : typeof tags.Duration === 'string'
              ? Number(tags.Duration)
              : undefined;
        const fileHasDuration = typeof fromFile === 'number' && Number.isFinite(fromFile) && fromFile > 0;
        const clientHasDuration =
          typeof clientDurationSeconds === 'number' &&
          Number.isFinite(clientDurationSeconds) &&
          clientDurationSeconds > 0 &&
          clientDurationSeconds <= MAX_CLIENT_DURATION_SECONDS;
        durationSeconds = fileHasDuration ? fromFile : clientHasDuration ? clientDurationSeconds : undefined;

        if (durationSeconds === undefined) {
          return {
            passed: false,
            reason:
              'Could not read the length of this video. Record it again.',
          };
        }

        if (durationSeconds < WALKTHROUGH_MIN_DURATION_SECONDS) {
          return {
            passed: false,
            reason: `This video is only ${Math.round(durationSeconds)}s long. Record at least ${WALKTHROUGH_MIN_DURATION_SECONDS} seconds, covering the main room, the outlook, and a live speed test.`,
            durationSeconds,
          };
        }

        const assessment = assessWalkthroughMetadata(tags, durationSeconds, Date.now(), { capturedInApp: true });
        if (assessment.failure) {
          return { passed: false, reason: assessment.failure, durationSeconds };
        }

        const warnings = [...assessment.warnings];
        if (!fileHasDuration) {
          warnings.push('The video file carries no length of its own; the length was reported by the browser.');
        }
        check = {
          method: 'camera_captured',
          visuallyVerified: false,
          capture,
          durationSeconds,
          durationSource: fileHasDuration ? 'file' : 'client_reported',
          recordedAt: assessment.recordedAt,
          warnings,
          checkedAt: new Date().toISOString(),
          ...(bypass ? { bypassed: true as const } : {}),
        };
      }

      // The video's own storage location is known before it is uploaded (the
      // upload finishes in the background below), and goes in the receipt so
      // the submit saves the URL the SERVER issued, not one the client typed.
      const storagePath = `${userId}/walkthrough/${randomUUID()}.${ext}`;
      const walkthroughVideoUrl = this.supabase.client.storage
        .from('listing-media')
        .getPublicUrl(storagePath).data.publicUrl;

      // Issue a one-time token naming exactly this (userId, pin) pair, so
      // submitFull/resubmit can later refuse to trust a bare
      // `walkthroughPassed: true` unless it's accompanied by proof the check
      // was actually run against the SAME coordinates being submitted now.
      // Stored in Redis (not draft_data) because at check time there may be
      // no listing row yet — this only needs to survive until the submit
      // that follows in the same session. The outcome rides along so the
      // submit can save it with the listing.
      const walkthroughToken = randomUUID();
      const tokenKey = walkthroughTokenKey(userId, walkthroughToken);
      const tokenValue = JSON.stringify({ lat: pin.lat, lng: pin.lng, check, videoUrl: walkthroughVideoUrl });
      // A first failure usually means the cache connection had just gone
      // stale and has been replaced, so one more try normally succeeds. If it
      // still cannot be saved the check must not report success: the submit
      // that follows would refuse a token that was never stored.
      const tokenSaved =
        (await this.redis.set(tokenKey, tokenValue, WALKTHROUGH_TOKEN_TTL_SECONDS)) ||
        (await this.redis.set(tokenKey, tokenValue, WALKTHROUGH_TOKEN_TTL_SECONDS));
      if (!tokenSaved) {
        return {
          passed: false,
          reason: 'The video is fine, but we could not save the result just now. Please send the video again.',
          distanceMetres: capture.distanceFromPinM,
          durationSeconds,
        };
      }

      // Only a PASSED check's video is kept, so the pin re-check at submit
      // time (readWalkthroughToken) can enforce the video matches the
      // listing, and so the reviewer has the footage to watch. The upload to
      // storage can take a long time for a big video and the proxy in front
      // of this route gives up after a while, so the check answers now and
      // the upload finishes in the background, which also becomes
      // responsible for deleting the temp file.
      this.storeWalkthroughVideoInBackground(file.path, mimetype, storagePath, tokenKey);
      tempFileHandedOff = true;

      return {
        passed: true,
        method: check.method,
        needsVisualReview: true,
        warnings: check.warnings,
        distanceMetres: capture.distanceFromPinM,
        durationSeconds,
        capture: {
          distanceFromPinM: capture.distanceFromPinM,
          accuracyM: capture.accuracyM,
          capturedAt: capture.capturedAt,
        },
        walkthroughToken,
        walkthroughVideoUrl,
      };
    } finally {
      if (!tempFileHandedOff) await unlink(file.path).catch(() => {});
    }
  }

  /**
   * Uploads a passed walkthrough video to storage AFTER the check has already
   * answered, then deletes the temp file. It must never take the process down:
   * the read stream's own errors and any upload failure are logged and
   * swallowed, and the stream is never left
   * unread while its file is deleted, which would surface as an unhandled
   * ENOENT error event. A stalled upload is abandoned after 10 minutes. A
   * failed upload withdraws the walkthrough receipt (the reviewer needs the
   * footage, so the check must not stay passed without it).
   */
  private storeWalkthroughVideoInBackground(
    filePath: string,
    mimetype: string,
    storagePath: string,
    tokenKey: string,
  ): void {
    const stream = createReadStream(filePath);
    stream.on('error', (err) => this.logger.warn(`walkthrough video read failed: ${err.message}`));

    void (async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        const upload = this.supabase.client.storage
          .from('listing-media')
          .upload(storagePath, stream, { contentType: mimetype, duplex: 'half' });
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('upload timed out after 10 minutes')), 10 * 60 * 1000);
        });
        const { error } = await Promise.race([upload, timeout]);
        if (error) throw new Error(error.message);
      } catch (err) {
        this.logger.warn(`walkthrough video upload failed: ${(err as Error).message}`);
        // The reviewer would get a link to nothing, so the receipt is withdrawn:
        // the host is told to record again instead of submitting a dead link.
        await this.redis.del(tokenKey).catch(() => {});
      } finally {
        if (timer) clearTimeout(timer);
        stream.destroy();
        await unlink(filePath).catch(() => {});
      }
    })();
  }

  /** The full property schema, plus the location rules a schema cannot hold. */
  private parseProperty(d: Parameters<typeof listingSchema.parse>[0]) {
    const property = listingSchema.parse(d);
    assertLocationIsValid(property);
    return property;
  }

  /**
   * Reads a walkthrough receipt (see verifyWalkthroughVideo) and re-checks it
   * against the pin of THIS submission. A host who records at one pin, then
   * moves the pin before submitting, fails here even though
   * `walkthroughPassed` in the body still reads `true` — that boolean is never
   * trusted on its own.
   *
   * Two distances are re-measured: the pin the check ran against vs the pin
   * now, and the device-reported capture point vs the pin now (the second is
   * what the reviewer sees, so it must be true of the final pin).
   *
   * `consume` makes it single-use: the token is deleted once it has passed, so
   * a captured token can't be replayed against a second, different submission.
   * A refused check leaves it in place (it is re-checked on every use and
   * expires on its own), so the host's retry does not need a new recording. Save-draft reads without consuming
   * (the host is not done yet).
   *
   * Returns null when there is no such receipt (never issued, expired,
   * consumed, or issued to another user).
   */
  private async readWalkthroughToken(
    userId: string,
    token: string,
    pin: { lat: number; lng: number } | undefined,
    consume: boolean,
  ): Promise<{ check: WalkthroughCheckRecord; videoUrl?: string } | null> {
    const key = walkthroughTokenKey(userId, token);
    const raw = await this.redis.get(key);
    if (!raw) return null;

    let stored: { lat: number; lng: number; check?: WalkthroughCheckRecord; videoUrl?: string };
    try {
      stored = JSON.parse(raw);
    } catch {
      throw new BadRequestException(
        'Your walkthrough check is invalid. Record the walkthrough again before submitting.',
      );
    }
    if (!stored.check) {
      throw new BadRequestException(
        'Your walkthrough check is invalid. Record the walkthrough again before submitting.',
      );
    }

    let check = stored.check;
    if (pin && !this.locationBypass) {
      if (distanceMetres(pin, stored) > WALKTHROUGH_GPS_TOLERANCE_METRES) {
        throw new BadRequestException(
          'The pin has moved since you recorded the walkthrough. Record the walkthrough again at the current pin before submitting.',
        );
      }
      if (isCaptureRecord(check.capture)) {
        const measured = withDistanceFrom(check.capture, pin);
        if (!isWithinTolerance(measured)) {
          throw new BadRequestException(
            `The walkthrough was recorded ${formatDistance(measured.distanceFromPinM)} from the pin you have now (the limit is ${WALKTHROUGH_GPS_TOLERANCE_METRES} m). Record it again at the property, or move the pin back.`,
          );
        }
        check = { ...check, capture: measured };
      }
    }
    // The video is stored in the background after the check answers, so the
    // reviewer's copy may not exist (still uploading, or the upload failed).
    // Do not send a listing to review with a link to nothing.
    if (consume && stored.videoUrl && (await this.walkthroughVideoMissing(stored.videoUrl))) {
      throw new BadRequestException(
        'Your walkthrough video has not finished uploading, or the upload failed. Wait a moment and submit again; if it keeps failing, record the walkthrough again.',
      );
    }
    // Spent only once it has passed every check above: a submit refused for
    // another reason (or a pin that is moved back) must not cost the host the
    // recording. Callers also run this last, right before the save.
    if (consume) await this.redis.del(key);
    return { check, videoUrl: stored.videoUrl };
  }

  /** True only when storage answers and the video is definitely not there. An
   *  unreachable or unexpected answer is not treated as missing, so a storage
   *  hiccup cannot block a submit on its own. */
  private async walkthroughVideoMissing(videoUrl: string): Promise<boolean> {
    try {
      const marker = '/listing-media/';
      const at = videoUrl.indexOf(marker);
      if (at < 0) return false;
      const full = decodeURIComponent(videoUrl.slice(at + marker.length).split('?')[0]);
      const slash = full.lastIndexOf('/');
      const dir = full.slice(0, slash);
      const name = full.slice(slash + 1);
      const { data, error } = await this.supabase.client.storage
        .from('listing-media')
        .list(dir, { search: name, limit: 5 });
      if (error || !Array.isArray(data)) return false;
      return !data.some((f) => f.name === name);
    } catch (err) {
      this.logger.warn(`walkthrough video presence check failed: ${(err as Error).message}`);
      return false;
    }
  }

  /** What is saved as the listing's `telemetry`. `status` is deliberately
   *  never `passed`: the capture location is reported by the device and the
   *  automatic check cannot tell footage of this property from anything else,
   *  so the listing reaches the reviewer as `needs_review` until a person has
   *  watched the video. `walkthroughCheck` carries what the check did find.
   *  The one-time token is not stored: it is spent. */
  private walkthroughTelemetry(w: { check: WalkthroughCheckRecord; videoUrl?: string }) {
    return {
      walkthroughPassed: true as const,
      ...(w.videoUrl ? { walkthroughVideoUrl: w.videoUrl } : {}),
      status: 'needs_review' as const,
      walkthroughCheck: w.check,
    };
  }

  /**
   * The walkthrough part of a submit (submitFull / resubmit).
   *
   * 1. A fresh receipt from a recording made in this session wins: it is
   *    redeemed (single-use) and re-checked against the final pin.
   * 2. Otherwise — the host edited something unrelated and did not record
   *    again — the walkthrough already stored on the listing is kept, so editing
   *    a price does not force a re-recording. It is still re-measured against
   *    the final pin: moving the pin away from where it was recorded needs a new
   *    recording.
   *      - A stored camera capture is re-measured against the pin.
   *      - A walkthrough from before camera capture existed (no capture data)
   *        is kept as it is, but only on a listing that has already been
   *        submitted (status other than `draft`, where it passed the old
   *        token gate), and only while the pin has not moved from the pin the
   *        listing had. The reviewer sees it labelled as having no capture data.
   *    Never taken from the request body.
   */
  private async resolveWalkthrough(
    userId: string,
    token: string | undefined,
    pin: { lat: number; lng: number },
    existing: ListingEntity | null,
  ) {
    if (token) {
      const fresh = await this.readWalkthroughToken(userId, token, pin, true);
      if (fresh) return this.walkthroughTelemetry(fresh);
    }

    const prior = (existing?.draft_data as Record<string, any> | null) ?? {};
    const stored = prior.telemetry as Record<string, any> | undefined;
    if (stored?.walkthroughPassed === true) {
      const check = stored.walkthroughCheck as WalkthroughCheckRecord | undefined;
      if (check && isCaptureRecord(check.capture)) {
        const measured = withDistanceFrom(check.capture, pin);
        if (!isWithinTolerance(measured)) {
          throw new BadRequestException(
            `The walkthrough was recorded ${formatDistance(measured.distanceFromPinM)} from the pin you have now (the limit is ${WALKTHROUGH_GPS_TOLERANCE_METRES} m). Record it again at the property, or move the pin back.`,
          );
        }
        return { ...stored, walkthroughCheck: { ...check, capture: measured } };
      }

      const oldPin = prior.property_details;
      const oldPinKnown = typeof oldPin?.lat === 'number' && typeof oldPin?.lng === 'number';
      if (existing && existing.status !== 'draft' && oldPinKnown) {
        if (distanceMetres(pin, oldPin) > WALKTHROUGH_GPS_TOLERANCE_METRES) {
          throw new BadRequestException(
            'The pin has moved since the walkthrough was recorded. Record the walkthrough again at the current pin.',
          );
        }
        return stored;
      }
    }

    throw new BadRequestException(
      token
        ? 'Your walkthrough recording has expired or was already used. Record the walkthrough again before submitting.'
        : 'Record the walkthrough video with the camera before submitting.',
    );
  }

  /**
   * Works out the capture evidence for the photo list being saved.
   *
   * The form carries only URLs, and a URL the client types is not evidence of
   * anything, so each photo must be one of:
   *   - a photo already on this listing (its stored capture is kept; or, if it
   *     has none, it is a pre-capture upload and stays labelled as such — so
   *     editing an unrelated field never forces a re-capture), or
   *   - a photo with a live capture receipt for this host, i.e. taken with
   *     the in-app camera and uploaded through uploadPhotos.
   * Anything else is refused. Entries for photos no longer in the list are
   * dropped. When `pin` is given (submit) every capture is re-measured
   * against it and an out-of-range one is refused by name.
   */
  private async resolvePhotoCaptures(
    userId: string,
    photos: { url: string }[] | undefined,
    existing: ListingEntity | null,
    pin: { lat: number; lng: number } | undefined,
  ) {
    const prior = (existing?.draft_data as Record<string, any> | null) ?? {};
    const priorUrls = new Set<string>(
      (prior.property_details?.photos ?? []).map((p: { url: string } | string) => (typeof p === 'string' ? p : p.url)),
    );
    const priorCaptures: Record<string, unknown> = prior.captures?.photos ?? {};

    const captures: Record<string, CaptureRecord> = {};
    const tooFar: number[] = [];
    let legacy = 0;
    const list = photos ?? [];
    for (let i = 0; i < list.length; i++) {
      const { url } = list[i];
      let record: CaptureRecord | undefined;
      if (isCaptureRecord(priorCaptures[url])) {
        record = priorCaptures[url] as CaptureRecord;
      } else {
        const raw = await this.redis.get(captureReceiptKey(userId, url));
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            if (isCaptureRecord(parsed)) record = parsed;
          } catch {
            /* treated as no receipt */
          }
        }
      }

      if (!record) {
        if (priorUrls.has(url)) {
          legacy++;
          continue;
        }
        throw new BadRequestException(
          `Photo ${i + 1} is not a photo taken with the in-app camera, or its capture has expired (captures are kept for 24 hours before you submit). Remove it and take the photo again.`,
        );
      }

      if (pin) {
        record = withDistanceFrom(record, pin);
        if (!this.locationBypass && !isWithinTolerance(record)) tooFar.push(i + 1);
      }
      captures[url] = record;
    }

    if (tooFar.length > 0) {
      throw new BadRequestException(
        `${tooFar.length === 1 ? `Photo ${tooFar[0]} was` : `Photos ${tooFar.join(', ')} were`} captured more than ${WALKTHROUGH_GPS_TOLERANCE_METRES} m from the pin you have now. Retake ${tooFar.length === 1 ? 'it' : 'them'} at the property, or move the pin back.`,
      );
    }
    return { captures, legacy };
  }

  /** The optional property video can no longer be uploaded (see the
   *  media/video route). A value that is already on the listing is kept
   *  as it was; anything new is refused. */
  private assertVideoUrlUnchanged(videoUrl: unknown, existing: ListingEntity | null) {
    if (typeof videoUrl !== 'string' || videoUrl === '') return;
    const prior = (existing?.draft_data as Record<string, any> | null)?.media?.videoUrl;
    if (videoUrl !== prior) {
      throw new BadRequestException(
        'A property video can no longer be uploaded. Record the walkthrough video with the in-app camera instead.',
      );
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
        ...(draft.media ?? {}),
      },
    };
  }

  /**
   * Lets a host fix a `draft`/`changes_needed`/`rejected` listing, or edit an
   * already-`live` one, and send it for review. Overwrites
   * `property_details`/telemetry/banking the same way submitFull
   * builds them, then moves the row to `in_review` and clears the old
   * review note — a stale "changes needed" reason must not linger once the
   * host has acted on it. For a `live` row this is the entire edit
   * mechanism: the listing drops out of public search the instant this
   * runs (every public query filters on status = 'live'), so a guest is
   * never shown data the host is mid-changing, and it only returns to
   * `live` once an admin approves the edit through the same review queue a
   * first-time submission goes through.
   *
   * Identity/host-type still come from the verified profile, never the
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

    // Same account-level gate submitFull applies: an edit is just as capable
    // of putting a listing in front of the reviewer, so it must not be a way
    // around a verification that has since been revoked.
    const profile = await this.profiles.findOne({ where: { id: userId } });
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }
    assertKycVerified(profile, await this.verification.getMyStatus(userId));

    const parsed = fullOnboardingSchema.safeParse(upgradeLegacyLocation(body));
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues[0]?.message ?? 'Check the details entered.',
      );
    }
    const d = parsed.data;

    // Same server-side re-verification submitFull does — a resubmit/edit is
    // just as capable of swapping the pin after the walkthrough was recorded
    // as the original submit is. A host who did not record again keeps the
    // walkthrough already on the listing (resolveWalkthrough).
    const pin = { lat: d.lat, lng: d.lng };
    const property = this.parseProperty(d);
    const { captures } = await this.resolvePhotoCaptures(userId, property.photos, existing, pin);
    this.assertVideoUrlUnchanged(d.videoUrl, existing);
    // Last of the checks: it spends the one-time walkthrough receipt, so
    // nothing that can still refuse the submit may run after it.
    const telemetry = await this.resolveWalkthrough(userId, d.walkthroughToken, pin, existing);

    const priorDraft = (existing.draft_data as Record<string, any>) ?? {};
    const { banking: _droppedBanking, ...priorDraftWithoutBanking } = priorDraft;
    const draft_data = {
      ...priorDraftWithoutBanking,
      property_details: property,
      telemetry,
      media: mediaSchema.parse(d),
      captures: { photos: captures },
    };

    const wasLive = existing.status === 'live';

    existing.draft_data = draft_data;
    existing.status = 'in_review';
    existing.review_notes = null;
    existing.review_reason_category = null;
    existing.updated_at = new Date();

    const saved = await this.listings.save(existing);

    // This is the one HostListingsService write that can change what
    // public search/town-summary results return: a live listing dropping
    // to in_review must stop showing in cached results promptly, not just
    // after the cache's own short TTL. draft/changes_needed/rejected rows
    // were never in `live` and so were never in the cache to begin with.
    if (wasLive) {
      await this.redis.incrementVersion(SEARCH_CACHE_VERSION_KEY);
    }

    return { listingId: saved.id, status: 'in_review' as const };
  }

  /**
   * "Save & exit" — persists whatever the host has filled in so far as a
   * `draft`-status row, with no schema-completeness requirement (unlike
   * submitFull/resubmit, which both gate on fullOnboardingSchema). Called
   * repeatedly across a session: the first call creates the row, every call
   * after reuses `existingListingId` so the host's one in-progress draft
   * doesn't fork into several rows. Leaves `status` alone once it's past
   * `draft` — a host mid-fixing a `changes_needed` row who exits again must
   * not silently lose the fact that ops already reviewed it once — with one
   * exception: a `live` row is pulled back to `in_review`, since it's
   * publicly visible right now and an edit sitting in `draft_data` must not
   * go out to guests without another review pass (same as resubmit()).
   *
   * Identity/host-type are stamped from the verified profile the same
   * way submitFull does, so a draft row looks the same shape as a submitted
   * one once `findMineById`/the edit page read it back.
   */
  async saveDraft(userId: string, body: unknown, existingListingId?: string) {
    const profile = await this.profiles.findOne({ where: { id: userId } });
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }

    let existing: ListingEntity | null = null;
    if (existingListingId) {
      existing = await this.listings.findOne({
        where: { id: existingListingId, host_id: userId },
      });
      if (!existing) {
        throw new NotFoundException('Listing not found');
      }
      if (!EDITABLE_STATUSES.includes(existing.status)) {
        throw new ConflictException(
          'This listing cannot be saved as a draft right now.',
        );
      }
      // A live listing is what guests see, and a half-filled save cannot be
      // put in front of the reviewer in its place. Its edit is only ever sent
      // whole, through resubmit(), which validates it first.
      if (existing.status === 'live') {
        throw new ConflictException(
          'A live listing cannot be saved as a draft. Submit your changes for review, or leave without saving.',
        );
      }
    }

    const priorDraft = (existing?.draft_data as Record<string, any>) ?? {};
    const priorFlat: Record<string, unknown> = {
      ...(priorDraft.property_details ?? {}),
      ...(priorDraft.telemetry ?? {}),
      ...(priorDraft.banking ?? {}),
      ...(priorDraft.media ?? {}),
    };

    // RHF's controlled inputs need a defined default, so the client sends
    // untouched fields as '' / [] rather than omitting them — but zod's
    // `.partial()` only relaxes *absent* keys, not ones present-but-empty,
    // so e.g. streetAddress: '' still fails its own min(3) even though the
    // host hasn't reached that field yet. Stripping those out is what makes
    // an in-progress draft "partial" enough to validate — but only for a
    // field with no prior saved value. A field the host had already filled
    // in on an earlier save, then deliberately cleared back to '', must
    // still go through as '' (an explicit clear), or the stale saved value
    // would linger in draft_data forever with no way for the host to remove
    // it (previously: any '' silently kept whatever was saved from before).
    // A text field cleared back to '' can't go through the partial schema (it
    // still carries min-length rules), so it is taken out of the body and the
    // saved value dropped after the merge below. An emptied list ([]) is a valid
    // value and goes through, which is how removing every photo is saved.
    const clearedText = new Set<string>();
    const stripUntouchedEmpty = (obj: unknown): unknown => {
      if (typeof obj !== 'object' || obj === null || Array.isArray(obj))
        return obj;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        const isEmpty = v === '' || (Array.isArray(v) && v.length === 0);
        if (isEmpty && !(k in priorFlat)) continue;
        if (v === '') {
          clearedText.add(k);
          continue;
        }
        out[k] = v;
      }
      return out;
    };

    const parsed = draftSchema.safeParse(stripUntouchedEmpty(upgradeLegacyLocation(body)));
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues[0]?.message ?? 'Check the details entered.',
      );
    }
    const d = parsed.data;

    const property: Record<string, any> = {
      ...(priorDraft.property_details ?? {}),
      ...draftPropertySchema.parse(d),
    };
    for (const k of clearedText) delete property[k];
    const pin =
      typeof property.lat === 'number' && typeof property.lng === 'number'
        ? { lat: property.lat, lng: property.lng }
        : undefined;

    // Photos: same rule as submit (a photo must be one already on this listing
    // or a camera capture), so a draft cannot be used to smuggle in a URL that
    // the submit would later treat as "already on the listing". The pin is not
    // enforced here — the draft may be half-filled — only at submit.
    const { captures } = await this.resolvePhotoCaptures(userId, property.photos, existing, undefined);
    this.assertVideoUrlUnchanged(d.videoUrl, existing);

    // Telemetry is never copied from the request body here: a client-supplied
    // `walkthroughPassed: true` saved onto a draft would otherwise read as a
    // walkthrough that was checked. It is either what the server already
    // stored, or a still-valid receipt from a recording made just now (read
    // without spending it — the host has not submitted yet).
    let telemetry: Record<string, unknown> = priorDraft.telemetry ?? {};
    if (d.walkthroughToken) {
      try {
        const fresh = await this.readWalkthroughToken(userId, d.walkthroughToken, pin, false);
        if (fresh) telemetry = this.walkthroughTelemetry(fresh);
      } catch {
        /* an out-of-range or unreadable receipt is reported at submit; keep what was stored */
      }
    }

    const draft_data = {
      ...priorDraft,
      kind: { host_kind: profile.host_kind },
      identity: { pan: profile.pan, gst: profile.gst ?? '' },
      property_details: property,
      telemetry,
      media: { ...(priorDraft.media ?? {}), ...mediaSchema.partial().parse(d) },
      captures: { photos: captures },
    };

    const row = existing
      ? Object.assign(existing, { draft_data, updated_at: new Date() })
      : this.listings.create({ host_id: userId, status: 'draft', draft_data });

    const saved = await this.listings.save(row);
    return { listingId: saved.id, status: saved.status };
  }

  /**
   * The caller's most recent `draft`-status row, if any — lets the wizard
   * offer to resume it on a fresh device/browser instead of only the
   * same-device localStorage autosave. Not `changes_needed`/`rejected`:
   * those already have a dedicated resume path (the "fix and resubmit" link
   * from HostListings), and surfacing them here too would let a host
   * "continue" a review-bounced listing without ever seeing why it bounced.
   */
  async findLatestDraft(userId: string, targetListingId?: string) {
    // A forced resume names the exact draft it saved — that row must be the
    // one returned, not whatever "most recent" resolves to. Multiple
    // concurrent drafts for the same host are a real case (the host started
    // a second listing), and "most recent by updated_at" is not even well-defined when
    // updated_at is null, which every draft row currently is regardless —
    // saveDraft sets it, but nothing backfills it for a row inserted
    // outside that path. Filtering by id when the caller has one sidesteps
    // that ordering question entirely instead of depending on it.
    const row = targetListingId
      ? await this.listings.findOne({
          where: { id: targetListingId, host_id: userId, status: 'draft' },
        })
      : await this.listings.findOne({
          where: { host_id: userId, status: 'draft' },
          order: { updated_at: 'DESC' },
        });
    if (!row) {
      return { listing: null };
    }

    const draft = (row.draft_data as Record<string, any>) ?? {};
    return {
      listing: {
        id: row.id,
        updatedAt: row.updated_at
          ? row.updated_at instanceof Date
            ? row.updated_at.toISOString()
            : (row.updated_at as unknown as string)
          : null,
        draft: {
          ...(draft.property_details ?? {}),
          ...(draft.telemetry ?? {}),
          ...(draft.banking ?? {}),
            ...(draft.media ?? {}),
        },
      },
    };
  }

  /**
   * The single write for the one-page listing form. Identity/host-type
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
  async submitFull(userId: string, body: unknown, existingListingId?: string) {
    const profile = await this.profiles.findOne({ where: { id: userId } });
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }

    const verificationStatus = await this.verification.getMyStatus(userId);
    assertKycVerified(profile, verificationStatus);

    const parsed = fullOnboardingSchema.safeParse(upgradeLegacyLocation(body));
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues[0]?.message ?? 'Check the details entered.',
      );
    }
    const d = parsed.data;

    // A "Save & exit" earlier in this same session may have already created
    // a `draft` row — promote that row to `in_review` instead of creating a
    // second one for what the host experiences as a single listing attempt.
    let existing: ListingEntity | null = null;
    if (existingListingId) {
      existing = await this.listings.findOne({
        where: { id: existingListingId, host_id: userId },
      });
      if (existing && existing.status !== 'draft') {
        // Already submitted (a double click, a second tab): say so rather than
        // quietly creating a second listing for the same attempt.
        throw new ConflictException('This listing has already been submitted.');
      }
    }

    // Re-verify server-side that the walkthrough was recorded for THIS pin —
    // never trust the client-supplied walkthroughPassed boolean alone (see
    // readWalkthroughToken / resolveWalkthrough). Throws if there is no
    // usable recording, or it was made for a different pin. Every photo must
    // likewise be a camera capture near this pin (resolvePhotoCaptures).
    const pin = { lat: d.lat, lng: d.lng };
    const property = this.parseProperty(d);
    const { captures } = await this.resolvePhotoCaptures(userId, property.photos, existing, pin);
    this.assertVideoUrlUnchanged(d.videoUrl, existing);
    // Last of the checks: it spends the one-time walkthrough receipt, so
    // nothing that can still refuse the submit may run after it.
    const telemetry = await this.resolveWalkthrough(userId, d.walkthroughToken, pin, existing);

    const draft_data = {
      // From the verified profile, never from the request body.
      kind: { host_kind: profile.host_kind },
      identity: { pan: profile.pan, gst: profile.gst ?? '' },
      // From this submission.
      property_details: property,
      telemetry,
      // Not a form field — payout details live on the verified account
      // (users.bank_account_number/bank_ifsc/bank_account_holder_name,
      // gated through assertKycVerified above), never re-collected per listing.
      media: mediaSchema.parse(d),
      // Where, per the device, each photo was captured. Kept out of
      // property_details because that block is public (listing-mapper.ts) and
      // the capture coordinates are the property's exact location.
      captures: { photos: captures },
    };

    return await this.dataSource.transaction(async (manager) => {
      const listings = manager.getRepository(ListingEntity);
      if (existing) {
        // Locked and re-read so two simultaneous submits of one draft cannot
        // both promote it (or one promote it while the other forks a row).
        const locked = await listings.findOne({
          where: { id: existing.id, host_id: userId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!locked || locked.status !== 'draft') {
          throw new ConflictException('This listing has already been submitted.');
        }
      }
      const row = existing
        ? Object.assign(existing, {
            status: 'in_review',
            draft_data,
            updated_at: new Date(),
          })
        : listings.create({
            host_id: userId,
            status: 'in_review',
            draft_data,
          });
      const saved = await listings.save(row);

      return { listingId: saved.id, status: 'in_review' as const };
    });
  }
}
