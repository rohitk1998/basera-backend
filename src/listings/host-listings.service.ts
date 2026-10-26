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
import { GeocodeService } from './geocode.service';
import { assertLocationAgrees, assertLocationIsValid, upgradeLegacyLocation } from './location.util';
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
import {
  applyWifiAmenity,
  buildWifiResult,
  cappedMbps,
  isWifiResult,
  isWifiTokenValue,
  parseSamples,
  serverMbps,
  speedtestKey,
  speedtestSamplesKey,
  wifiTestTokenKey,
  workCategoryAllowed,
  SPEEDTEST_MAX_STREAMS,
  SPEEDTEST_TTL_SECONDS,
  WIFI_TEST_TOKEN_TTL_SECONDS,
  WORK_CATEGORY,
  WORK_CATEGORY_MESSAGE,
  WORK_READY_MBPS,
  type StreamSample,
  type WifiAnswer,
  type WifiResult,
  type WifiTokenValue,
} from './wifi-test.util';

const WALKTHROUGH_TOKEN_TTL_SECONDS = 60 * 60;

function walkthroughTokenKey(userId: string, token: string): string {
  return `walkthrough-token:${userId}:${token}`;
}

const CAPTURE_RECEIPT_TTL_SECONDS = 24 * 60 * 60;

function captureReceiptKey(userId: string, url: string): string {
  return `capture-receipt:${userId}:${createHash('sha256').update(url).digest('hex')}`;
}
import {
  fullOnboardingSchema,
  listingIssues,
  clampPastAvailableFrom,
  listingSchema,
  mediaSchema,
  photoSchema,
  telemetrySchema,
  toFullAddress,
  ROOM_IDS,
} from './listing-schema';
import { z } from 'zod';

const draftPropertySchema = listingSchema.partial().extend({ photos: z.array(photoSchema).optional() });
const draftSchema = fullOnboardingSchema.partial().extend({ photos: z.array(photoSchema).optional() });

const wifiTestBodySchema = z.object({
  testId: z.string().uuid('Start the Wi-Fi test again.'),
  downMbps: z.number().nonnegative().max(100_000),
  upMbps: z.number().nonnegative().max(100_000),
  pingMs: z.number().nonnegative().max(60_000),
  jitterMs: z.number().nonnegative().max(60_000).optional(),
  connectionType: z.string().max(32).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  capture: z.unknown().optional(),
});

type DraftWifi = { answer?: WifiAnswer } & Partial<WifiResult>;

const wizardProgressSchema = z.object({
  currentStep: z.string().regex(/^[a-z]{2,12}$/),
  visitedSteps: z.array(z.string().regex(/^[a-z]{2,12}$/)).max(20),
  updatedAt: z.string().max(40),
});

type UploadedMulterFile = {
  buffer?: Buffer;
  path?: string;
  mimetype: string;
  size: number;
};

const PHOTO_ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
};
const PHOTO_MAX_BYTES = 8 * 1024 * 1024;

const VIDEO_ALLOWED_TYPES: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

const baseMimeType = (mimetype: string) => mimetype.split(';')[0].trim().toLowerCase();

const MAX_CLIENT_DURATION_SECONDS = 60 * 60;

const CAPTURE_REQUIRED_MESSAGE =
  'Photos and the walkthrough video must be taken with the in-app camera. Remove this one and capture it again.';
const VIDEO_MAX_BYTES = 150 * 1024 * 1024;

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

@Injectable()
export class HostListingsService implements OnModuleDestroy {
  private readonly logger = new Logger(HostListingsService.name);

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

    @Optional() private readonly captureConfig?: CaptureConfigService,

    @Optional() private readonly geocode?: GeocodeService,
  ) {}

  get locationBypass(): boolean {
    return this.captureConfig?.locationBypass === true;
  }

  async findMine(userId: string): Promise<HostListingSummary[]> {
    const rows = await this.listings.find({
      where: { host_id: userId },
      order: { created_at: 'DESC' },
    });

    return rows.map((row) => {
      const draft = (row.draft_data as Record<string, any>) ?? {};

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

        reviewNotes: row.review_notes ?? null,
        reviewReasonCategory: row.review_reason_category ?? null,
      };
    });
  }

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

    let tempFileHandedOff = false;
    try {
      const bypass = this.locationBypass;
      let capture: CaptureRecord;
      if (bypass) {
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

      const storagePath = `${userId}/walkthrough/${randomUUID()}.${ext}`;
      const walkthroughVideoUrl = this.supabase.client.storage
        .from('listing-media')
        .getPublicUrl(storagePath).data.publicUrl;

      const walkthroughToken = randomUUID();
      const tokenKey = walkthroughTokenKey(userId, walkthroughToken);
      const tokenValue = JSON.stringify({ lat: pin.lat, lng: pin.lng, check, videoUrl: walkthroughVideoUrl });

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

        await this.redis.del(tokenKey).catch(() => {});
      } finally {
        if (timer) clearTimeout(timer);
        stream.destroy();
        await unlink(filePath).catch(() => {});
      }
    })();
  }

  async startSpeedtest(userId: string): Promise<{ testId: string }> {
    const testId = randomUUID();
    const value = JSON.stringify({ startedAt: Date.now(), download: [], upload: [] });
    const key = speedtestKey(userId, testId);

    const stored =
      (await this.redis.set(key, value, SPEEDTEST_TTL_SECONDS)) ||
      (await this.redis.set(key, value, SPEEDTEST_TTL_SECONDS));
    if (!stored) {
      throw new InternalServerErrorException('The Wi-Fi test could not be started. Try again in a moment.');
    }
    return { testId };
  }

  async assertSpeedtest(userId: string, testId: unknown, direction?: 'download' | 'upload'): Promise<string> {
    if (typeof testId !== 'string' || !z.string().uuid().safeParse(testId).success) {
      throw new BadRequestException('Start the Wi-Fi test again.');
    }
    if (!(await this.redis.get(speedtestKey(userId, testId)))) {
      throw new BadRequestException('This Wi-Fi test has expired. Run the test again.');
    }
    if (direction) {
      const streams = await this.redis.getList(speedtestSamplesKey(userId, testId, direction));
      if (streams.length >= SPEEDTEST_MAX_STREAMS) {
        throw new BadRequestException('This Wi-Fi test has already finished. Run the test again.');
      }
    }
    return testId;
  }

  async recordSpeedtestSample(
    userId: string,
    testId: string,
    direction: 'download' | 'upload',
    sample: StreamSample,
  ): Promise<void> {
    if (sample.bytes <= 0) return;
    await this.redis.pushToList(
      speedtestSamplesKey(userId, testId, direction),
      JSON.stringify(sample),
      SPEEDTEST_TTL_SECONDS,
    );
  }

  async recordWifiTest(
    userId: string,
    body: unknown,
  ): Promise<
    | { passed: true; result: WifiResult; wifiTestToken: string; workReady: boolean }
    | { passed: false; reason: string }
  > {
    const parsed = wifiTestBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'The Wi-Fi test result is incomplete.');
    }
    const d = parsed.data;
    const testId = await this.assertSpeedtest(userId, d.testId);
    const pinIn =
      typeof d.lat === 'number' && typeof d.lng === 'number' ? { lat: d.lat, lng: d.lng } : undefined;

    let record: CaptureRecord;
    if (this.locationBypass) {
      if (!d.capture || typeof d.capture !== 'object' || Array.isArray(d.capture)) {
        return { passed: false, reason: 'This Wi-Fi test has no location details. Run it again in the app.' };
      }
      record = bypassedCaptureRecord('wifi', pinIn, d.capture);
    } else {
      if (!pinIn) return { passed: false, reason: 'Drop the pin on the map before running the Wi-Fi test.' };
      const claim = parseCaptureClaim(d.capture);
      if (!claim.ok) {
        return {
          passed: false,
          reason: 'Your phone did not report its location with the test. Allow location access and run the test again.',
        };
      }
      const assessed = assessCapture(claim.claim, pinIn, 'wifi');
      if (!assessed.ok) {
        const distance = distanceMetres(pinIn, { lat: claim.claim.lat, lng: claim.claim.lng });
        return {
          passed: false,
          reason:

            assessed.reason.includes('from the pin you dropped')
              ? `Your phone reported a location ${formatDistance(distance)} from the pin you dropped (the limit is ${WALKTHROUGH_GPS_TOLERANCE_METRES} m). Run the Wi-Fi test at the property, or move the pin onto the property.`
              : assessed.reason,
        };
      }
      record = assessed.record;
    }
    const pin = pinIn ?? { lat: record.lat, lng: record.lng };

    const [down, up] = await Promise.all([
      this.redis.getList(speedtestSamplesKey(userId, testId, 'download')).then(parseSamples),
      this.redis.getList(speedtestSamplesKey(userId, testId, 'upload')).then(parseSamples),
    ]);
    const serverDown = serverMbps(down);
    if (serverDown === null) {
      return {
        passed: false,
        reason: 'The Wi-Fi test did not reach our server. Check the connection and run the test again.',
      };
    }

    const result = buildWifiResult({
      downMbps: cappedMbps(d.downMbps, serverDown),
      upMbps: cappedMbps(d.upMbps, serverMbps(up)),
      pingMs: d.pingMs,
      jitterMs: d.jitterMs,
      connectionType: d.connectionType,
      capture: record,
    });

    const wifiTestToken = randomUUID();
    const tokenKey = wifiTestTokenKey(userId, wifiTestToken);
    const tokenValue = JSON.stringify({ lat: pin.lat, lng: pin.lng, record, result } satisfies WifiTokenValue);
    const stored =
      (await this.redis.set(tokenKey, tokenValue, WIFI_TEST_TOKEN_TTL_SECONDS)) ||
      (await this.redis.set(tokenKey, tokenValue, WIFI_TEST_TOKEN_TTL_SECONDS));
    if (!stored) {
      throw new InternalServerErrorException('The Wi-Fi test result could not be saved. Run the test again in a moment.');
    }

    await this.redis.del(speedtestKey(userId, testId));

    return { passed: true, result, wifiTestToken, workReady: result.downMbps > WORK_READY_MBPS };
  }

  private async readWifiTestToken(
    userId: string,
    token: string,
    pin: { lat: number; lng: number } | undefined,
  ): Promise<{ result: WifiResult; record: CaptureRecord } | null> {
    const raw = await this.redis.get(wifiTestTokenKey(userId, token));
    if (!raw) return null;
    let stored: unknown;
    try {
      stored = JSON.parse(raw);
    } catch {
      stored = null;
    }
    if (!isWifiTokenValue(stored)) {
      throw new BadRequestException('Your Wi-Fi test result is invalid. Run the Wi-Fi test again before submitting.');
    }
    let { record, result } = stored;
    if (pin && !this.locationBypass) {
      if (distanceMetres(pin, stored) > WALKTHROUGH_GPS_TOLERANCE_METRES) {
        throw new BadRequestException(
          'The pin has moved since you ran the Wi-Fi test. Run the Wi-Fi test again at the current pin before submitting.',
        );
      }
      record = withDistanceFrom(record, pin);
      if (!isWithinTolerance(record)) {
        throw new BadRequestException(
          `Your phone reported the Wi-Fi test ${formatDistance(record.distanceFromPinM)} from the pin you have now (the limit is ${WALKTHROUGH_GPS_TOLERANCE_METRES} m). Run it again at the property, or move the pin back.`,
        );
      }
      result = { ...result, capture: { ...result.capture, distanceFromPinM: record.distanceFromPinM } };
    }
    return { result, record };
  }

  private async resolveWifi(
    userId: string,
    input: { answer?: WifiAnswer; token?: string },
    pin: { lat: number; lng: number } | undefined,
    existing: ListingEntity | null,
    strict: boolean,
  ): Promise<{ wifi: DraftWifi | undefined; record: CaptureRecord | undefined; spend: () => Promise<void> }> {
    const prior = (existing?.draft_data as Record<string, any> | null) ?? {};
    const priorWifi = (prior.wifi as DraftWifi | undefined) ?? undefined;
    const answer = input.answer ?? priorWifi?.answer;
    const noop = async () => {};

    if (input.token) {
      try {
        const fresh = await this.readWifiTestToken(userId, input.token, pin);
        if (fresh) {
          const key = wifiTestTokenKey(userId, input.token);
          return {
            wifi: { answer, ...fresh.result },
            record: fresh.record,
            spend: async () => this.redis.del(key),
          };
        }
        if (strict && answer === 'yes' && !isWifiResult(priorWifi)) {
          throw new BadRequestException(
            'Your Wi-Fi test result has expired or was already used. Run the Wi-Fi test again before submitting.',
          );
        }
      } catch (err) {
        if (strict) throw err;
      }
    }

    const priorRecord = prior.captures?.wifi;
    if (isWifiResult(priorWifi)) {
      let record: CaptureRecord | undefined = isCaptureRecord(priorRecord) ? priorRecord : undefined;
      let result: WifiResult = priorWifi;
      if (pin && record) {
        record = withDistanceFrom(record, pin);
        if (!this.locationBypass && !isWithinTolerance(record)) {
          if (strict && answer === 'yes') {
            throw new BadRequestException(
              `The Wi-Fi test was run ${formatDistance(record.distanceFromPinM)} from the pin you have now (the limit is ${WALKTHROUGH_GPS_TOLERANCE_METRES} m). Run it again at the property, or move the pin back.`,
            );
          }
          return { wifi: answer ? { answer } : undefined, record: undefined, spend: noop };
        }
        result = { ...priorWifi, capture: { ...priorWifi.capture, distanceFromPinM: record.distanceFromPinM } };
      }
      const { answer: _a, ...measured } = result as DraftWifi;
      return { wifi: { answer, ...measured }, record, spend: noop };
    }
    return { wifi: answer ? { answer } : undefined, record: undefined, spend: noop };
  }

  private applyWifiRules(property: Record<string, any>, wifi: DraftWifi | undefined, enforceWork: boolean) {
    if (Array.isArray(property.amenities)) {
      property.amenities = applyWifiAmenity(property.amenities, wifi);
    }
    if (enforceWork && Array.isArray(property.categories) && property.categories.includes(WORK_CATEGORY)) {
      if (!workCategoryAllowed(wifi)) throw new BadRequestException(WORK_CATEGORY_MESSAGE);
    }
  }

  private async assertPinAgrees(p: { district: string; pincode: string; lat: number; lng: number }) {
    if (!this.geocode) return;
    await assertLocationAgrees(p, (lat, lng) => this.geocode!.reverseCheck(lat, lng), { skip: this.locationBypass });
  }

  private parseProperty(
    d: Parameters<typeof listingSchema.parse>[0],
    opts: { clampPastDate?: boolean } = {},
  ) {
    const property = listingSchema.parse(
      opts.clampPastDate ? clampPastAvailableFrom(d as { availableFrom?: string }, 'Asia/Kolkata') : d,
    );
    assertLocationIsValid(property, { skipPinRegion: this.locationBypass });
    const issue = Object.values(listingIssues(property, { timeZone: 'Asia/Kolkata' }))[0];
    if (issue) throw new BadRequestException(issue);
    return property;
  }

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

    if (consume && stored.videoUrl && (await this.walkthroughVideoMissing(stored.videoUrl))) {
      throw new BadRequestException(
        'Your walkthrough video has not finished uploading, or the upload failed. Wait a moment and submit again; if it keeps failing, record the walkthrough again.',
      );
    }

    if (consume) await this.redis.del(key);
    return { check, videoUrl: stored.videoUrl };
  }

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

  private walkthroughTelemetry(w: { check: WalkthroughCheckRecord; videoUrl?: string }) {
    return {
      walkthroughPassed: true as const,
      ...(w.videoUrl ? { walkthroughVideoUrl: w.videoUrl } : {}),
      status: 'needs_review' as const,
      walkthroughCheck: w.check,
    };
  }

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

  private assertVideoUrlUnchanged(videoUrl: unknown, existing: ListingEntity | null) {
    if (typeof videoUrl !== 'string' || videoUrl === '') return;
    const prior = (existing?.draft_data as Record<string, any> | null)?.media?.videoUrl;
    if (videoUrl !== prior) {
      throw new BadRequestException(
        'A property video can no longer be uploaded. Record the walkthrough video with the in-app camera instead.',
      );
    }
  }

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
        ...(draft.media ?? {}),
        ...(draft.wifi?.answer ? { wifiAnswer: draft.wifi.answer } : {}),
      },
      wifi: draft.wifi ?? null,
    };
  }

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

    const pin = { lat: d.lat, lng: d.lng };

    const property = this.parseProperty(d, { clampPastDate: existing.status !== 'draft' });
    await this.assertPinAgrees(property);
    const { captures } = await this.resolvePhotoCaptures(userId, property.photos, existing, pin);
    this.assertVideoUrlUnchanged(d.videoUrl, existing);
    const wifi = await this.resolveWifi(userId, { answer: d.wifiAnswer, token: d.wifiTestToken }, pin, existing, true);
    this.applyWifiRules(property, wifi.wifi, true);

    const telemetry = await this.resolveWalkthrough(userId, d.walkthroughToken, pin, existing);
    await wifi.spend();

    const priorDraft = (existing.draft_data as Record<string, any>) ?? {};
    const {
      banking: _droppedBanking,
      wizard: _droppedWizard,
      wifi: _replacedWifi,
      ...priorDraftWithoutBanking
    } = priorDraft;
    const draft_data = {
      ...priorDraftWithoutBanking,
      property_details: property,
      telemetry,
      ...(wifi.wifi ? { wifi: wifi.wifi } : {}),
      media: mediaSchema.parse(d),
      captures: { photos: captures, ...(wifi.record ? { wifi: wifi.record } : {}) },
    };

    const wasLive = existing.status === 'live';

    existing.draft_data = draft_data;
    existing.status = 'in_review';
    existing.review_notes = null;
    existing.review_reason_category = null;
    existing.updated_at = new Date();

    const saved = await this.listings.save(existing);

    if (wasLive) {
      await this.redis.incrementVersion(SEARCH_CACHE_VERSION_KEY);
    }

    return { listingId: saved.id, status: 'in_review' as const };
  }

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
      ...(priorDraft.media ?? {}),
    };

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

    const { captures } = await this.resolvePhotoCaptures(userId, property.photos, existing, undefined);
    this.assertVideoUrlUnchanged(d.videoUrl, existing);

    let telemetry: Record<string, unknown> = priorDraft.telemetry ?? {};
    if (d.walkthroughToken) {
      try {
        const fresh = await this.readWalkthroughToken(userId, d.walkthroughToken, pin, false);
        if (fresh) telemetry = this.walkthroughTelemetry(fresh);
      } catch {
      }
    }

    const wifi = await this.resolveWifi(userId, { answer: d.wifiAnswer, token: d.wifiTestToken }, pin, existing, false);
    this.applyWifiRules(property, wifi.wifi, false);

    const wizard = wizardProgressSchema.safeParse((body as { wizard?: unknown } | null)?.wizard);

    const draft_data = {
      ...priorDraft,
      ...(wizard.success ? { wizard: wizard.data } : {}),
      kind: { host_kind: profile.host_kind },
      identity: { gst: profile.gst ?? '' },
      property_details: property,
      telemetry,
      ...(wifi.wifi ? { wifi: wifi.wifi } : {}),
      media: { ...(priorDraft.media ?? {}), ...mediaSchema.partial().parse(d) },
      captures: { photos: captures, ...(wifi.record ? { wifi: wifi.record } : {}) },
    };

    const row = existing
      ? Object.assign(existing, { draft_data, updated_at: new Date() })
      : this.listings.create({ host_id: userId, status: 'draft', draft_data });

    const saved = await this.listings.save(row);
    return { listingId: saved.id, status: saved.status };
  }

  async findLatestDraft(userId: string, targetListingId?: string) {
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
          ...(draft.media ?? {}),
          ...(draft.wifi?.answer ? { wifiAnswer: draft.wifi.answer } : {}),
        },
        wizard: draft.wizard ?? null,

        wifi: draft.wifi ?? null,
      },
    };
  }

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

    let existing: ListingEntity | null = null;
    if (existingListingId) {
      existing = await this.listings.findOne({
        where: { id: existingListingId, host_id: userId },
      });
      if (existing && existing.status !== 'draft') {
        throw new ConflictException('This listing has already been submitted.');
      }
    }

    const pin = { lat: d.lat, lng: d.lng };
    const property = this.parseProperty(d);
    await this.assertPinAgrees(property);
    const { captures } = await this.resolvePhotoCaptures(userId, property.photos, existing, pin);
    this.assertVideoUrlUnchanged(d.videoUrl, existing);

    const wifi = await this.resolveWifi(userId, { answer: d.wifiAnswer, token: d.wifiTestToken }, pin, existing, true);
    this.applyWifiRules(property, wifi.wifi, true);

    const telemetry = await this.resolveWalkthrough(userId, d.walkthroughToken, pin, existing);
    await wifi.spend();

    const draft_data = {
      kind: { host_kind: profile.host_kind },
      identity: { gst: profile.gst ?? '' },

      property_details: property,
      telemetry,

      ...(wifi.wifi ? { wifi: wifi.wifi } : {}),
      media: mediaSchema.parse(d),

      captures: { photos: captures, ...(wifi.record ? { wifi: wifi.record } : {}) },
    };

    return await this.dataSource.transaction(async (manager) => {
      const listings = manager.getRepository(ListingEntity);
      if (existing) {
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
