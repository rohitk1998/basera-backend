import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { randomBytes } from 'crypto';
import * as os from 'os';
import { unlink } from 'fs/promises';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { HostListingsService } from './host-listings.service';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { clampDownloadBytes, SPEEDTEST_MAX_BYTES } from './wifi-test.util';

interface UploadedMulterFile {
  buffer?: Buffer;
  path?: string;
  mimetype: string;
  size: number;
}

const PHOTO_MAX_BYTES = 8 * 1024 * 1024;
const VIDEO_MAX_BYTES = 150 * 1024 * 1024;

const blank = (raw: unknown) => raw === undefined || raw === null || String(raw).trim() === '';

function parsePin(latRaw: unknown, lngRaw: unknown, message: string): { lat: number; lng: number } {
  const lat = blank(latRaw) ? NaN : Number(latRaw);
  const lng = blank(lngRaw) ? NaN : Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new BadRequestException(message);
  }
  return { lat, lng };
}

function parseJsonArray(raw: unknown, name: string): unknown[] {
  try {
    const v = JSON.parse(typeof raw === 'string' ? raw : '[]');
    if (Array.isArray(v)) return v;
  } catch {
  }
  throw new BadRequestException(`${name} must be a JSON array`);
}

function parseJsonObject(raw: unknown, name: string, bypass = false): unknown {
  if (typeof raw !== 'string' || raw.trim() === '') {
    if (bypass && raw !== undefined) return {};
    throw new BadRequestException(
      'This video has no camera capture details. Record it with the in-app camera, with location access allowed.',
    );
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new BadRequestException(`${name} must be JSON`);
  }
}

let speedtestBlock: Buffer | undefined;
const speedtestChunk = () => (speedtestBlock ??= randomBytes(256 * 1024));

const SPEEDTEST_THROTTLE = { default: { ttl: 60_000, limit: 240 } };

@Controller('api/host/listings')
@UseGuards(AuthGuard)
export class HostListingsController {
  constructor(private readonly hostListingsService: HostListingsService) {}

  private pinOrUndefined(latRaw: unknown, lngRaw: unknown, message: string) {
    if (this.hostListingsService.locationBypass && (blank(latRaw) || blank(lngRaw))) return undefined;
    return parsePin(latRaw, lngRaw, message);
  }

  @Get('capture-config')
  captureConfig() {
    return { success: true, locationBypass: this.hostListingsService.locationBypass };
  }

  @Get()
  async findMine(@CurrentUser() user: AuthUser) {
    const listings = await this.hostListingsService.findMine(user.userId);
    return { success: true, listings };
  }

  @ResponseMessage('Listing submitted for review.')
  @Post('submit-full')
  async submitFull(
    @CurrentUser() user: AuthUser,
    @Body('listingId') existingListingId: string | undefined,
    @Body() body: unknown,
  ) {
    const { listingId, status } = await this.hostListingsService.submitFull(
      user.userId,
      body,
      existingListingId,
    );
    return { success: true, listingId, status };
  }

  @ResponseMessage('Draft saved.')
  @Post('save-draft')
  async saveDraft(
    @CurrentUser() user: AuthUser,
    @Body('listingId') listingId: string | undefined,
    @Body() body: unknown,
  ) {
    const { listingId: id, status } = await this.hostListingsService.saveDraft(
      user.userId,
      body,
      listingId,
    );
    return { success: true, listingId: id, status };
  }

  @Get('draft')
  async latestDraft(@CurrentUser() user: AuthUser, @Query('listingId') listingId?: string) {
    const { listing } = await this.hostListingsService.findLatestDraft(user.userId, listingId);
    return { success: true, listing };
  }

  @ResponseMessage('Photos uploaded.')
  @Post('media/photos')
  @UseInterceptors(FilesInterceptor('files', 20, { limits: { fileSize: PHOTO_MAX_BYTES } }))
  async uploadPhotos(
    @CurrentUser() user: AuthUser,
    @Body('rooms') roomsJson: string,
    @Body('captures') capturesJson: string,
    @Body('lat') latRaw: string,
    @Body('lng') lngRaw: string,
    @UploadedFiles() files?: UploadedMulterFile[],
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('No files provided');
    }
    const rooms = parseJsonArray(roomsJson, 'rooms');
    const captures = parseJsonArray(capturesJson, 'captures');
    const pin = this.pinOrUndefined(latRaw, lngRaw, 'Drop the pin on the map before taking photos.');
    const photos = await this.hostListingsService.uploadPhotos(user.userId, files, rooms as string[], pin, captures);
    return { success: true, photos };
  }

  @ResponseMessage('Property videos can no longer be uploaded.')
  @Post('media/video')
  async uploadVideo() {
    throw new BadRequestException(
      'Property videos can no longer be uploaded. Record the walkthrough video with the in-app camera instead.',
    );
  }

  @ResponseMessage((r) =>
    r.passed
      ? r.method === 'unanalysed'
        ? 'Video received. Our team will review it.'
        : 'Video recorded near the pin (location reported by your device). Our team will review it.'
      : (r.reason ?? 'The walkthrough video could not be checked.'),
  )
  @Post('media/walkthrough')
  @UseInterceptors(FileInterceptor('video', { dest: os.tmpdir(), limits: { fileSize: VIDEO_MAX_BYTES } }))
  async verifyWalkthrough(
    @CurrentUser() user: AuthUser,
    @Body('lat') latRaw: string,
    @Body('lng') lngRaw: string,
    @Body('capture') captureJson: string,
    @Body('durationSeconds') durationRaw: string,
    @UploadedFile() file?: UploadedMulterFile,
  ) {
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    let pin: { lat: number; lng: number } | undefined;
    let capture: unknown;
    try {
      pin = this.pinOrUndefined(latRaw, lngRaw, 'Drop the pin on the map before recording the video.');
      capture = parseJsonObject(captureJson, 'capture', this.hostListingsService.locationBypass);
    } catch (err) {
      if (file.path) await unlink(file.path).catch(() => {});
      throw err;
    }
    const duration = durationRaw === undefined || String(durationRaw).trim() === '' ? undefined : Number(durationRaw);
    const result = await this.hostListingsService.verifyWalkthroughVideo(user.userId, file, pin, capture, duration);
    return { success: true, ...result };
  }

  @Post('speedtest/start')
  async startSpeedtest(@CurrentUser() user: AuthUser) {
    const { testId } = await this.hostListingsService.startSpeedtest(user.userId);
    return { success: true, testId };
  }

  @Throttle(SPEEDTEST_THROTTLE)
  @Get('speedtest/ping')
  @Header('Cache-Control', 'no-store')
  async speedtestPing(@CurrentUser() user: AuthUser, @Query('testId') testId: string) {
    await this.hostListingsService.assertSpeedtest(user.userId, testId);
    return { t: Date.now() };
  }

  @Throttle(SPEEDTEST_THROTTLE)
  @Get('speedtest/download')
  async speedtestDownload(
    @CurrentUser() user: AuthUser,
    @Query('testId') testIdRaw: string,
    @Query('bytes') bytesRaw: string,
    @Res() res: Response,
  ) {
    const testId = await this.hostListingsService.assertSpeedtest(user.userId, testIdRaw, 'download');
    const total = clampDownloadBytes(bytesRaw);
    res.status(200);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Encoding', 'identity');
    res.setHeader('Content-Length', String(total));

    const chunk = speedtestChunk();
    let written = 0;
    let firstAt = 0;
    let lastAt = 0;
    let recorded = false;
    const record = () => {
      if (recorded) return;
      recorded = true;
      void this.hostListingsService
        .recordSpeedtestSample(user.userId, testId, 'download', { bytes: written, firstAt, lastAt })
        .catch(() => {});
    };
    res.on('close', record);

    const pump = () => {
      while (written < total && !res.destroyed) {
        const n = Math.min(chunk.length, total - written);
        const ok = res.write(n === chunk.length ? chunk : chunk.subarray(0, n));
        const now = Date.now();
        if (!firstAt) firstAt = now;
        lastAt = now;
        written += n;
        if (!ok) {
          res.once('drain', pump);
          return;
        }
      }
      if (written >= total) {
        res.end();
        record();
      }
    };
    pump();
  }

  @Throttle(SPEEDTEST_THROTTLE)
  @Post('speedtest/upload')
  async speedtestUpload(
    @CurrentUser() user: AuthUser,
    @Query('testId') testIdRaw: string,
    @Req() req: Request,
  ) {
    const testId = await this.hostListingsService.assertSpeedtest(user.userId, testIdRaw, 'upload');
    let bytes = 0;
    let firstAt = 0;
    let lastAt = 0;
    await new Promise<void>((resolve, reject) => {
      if (req.readableEnded) return resolve();
      req.on('data', (c: Buffer) => {
        const now = Date.now();
        if (!firstAt) firstAt = now;
        lastAt = now;
        bytes += c.length;
        if (bytes > SPEEDTEST_MAX_BYTES) {
          req.destroy();
          reject(new BadRequestException('A speed test upload may be at most 25 MB.'));
        }
      });
      req.on('end', () => resolve());
      req.on('aborted', () => resolve());
      req.on('error', (err) => reject(err));
    });
    await this.hostListingsService.recordSpeedtestSample(user.userId, testId, 'upload', { bytes, firstAt, lastAt });
    return { success: true, bytes };
  }

  @ResponseMessage((r) =>
    r.passed ? 'Wi-Fi speed measured at the property.' : (r.reason ?? 'The Wi-Fi test could not be checked.'),
  )
  @Post('wifi-test')
  async wifiTest(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const result = await this.hostListingsService.recordWifiTest(user.userId, body);
    return { success: true, ...result };
  }

  @Get(':id')
  async findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const listing = await this.hostListingsService.findMineById(user.userId, id);
    return { success: true, listing };
  }

  @ResponseMessage('Listing updated and sent for review.')
  @Patch(':id')
  async resubmit(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const { listingId, status } = await this.hostListingsService.resubmit(user.userId, id, body);
    return { success: true, listingId, status };
  }
}
