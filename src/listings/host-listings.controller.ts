import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import * as os from 'os';
import { unlink } from 'fs/promises';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { HostListingsService } from './host-listings.service';
import { ResponseMessage } from '../common/decorators/response-message.decorator';

interface UploadedMulterFile {
  buffer?: Buffer;
  path?: string;
  mimetype: string;
  size: number;
}

const PHOTO_MAX_BYTES = 8 * 1024 * 1024;
const VIDEO_MAX_BYTES = 150 * 1024 * 1024;

const blank = (raw: unknown) => raw === undefined || raw === null || String(raw).trim() === '';

/** The pin comes from a form field. Number('') is 0, so a blank one must be
 *  refused explicitly or it would silently be checked against 0,0 (the Gulf of
 *  Guinea). */
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
    /* falls through */
  }
  throw new BadRequestException(`${name} must be a JSON array`);
}

function parseJsonObject(raw: unknown, name: string, bypass = false): unknown {
  if (typeof raw !== 'string' || raw.trim() === '') {
    // Bypass (test only): the capture object may be absent of location, but a
    // client that sends nothing at all is not using the in-app camera path.
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

/**
 * Host-facing listing management. Ported from web/app/api/host/listings/
 * route.ts, .../[id]/route.ts and .../submit-full/route.ts. No notifications
 * are sent from any of these routes in the original — only admin review and
 * booking actions do that.
 */
@Controller('api/host/listings')
@UseGuards(AuthGuard)
export class HostListingsController {
  constructor(private readonly hostListingsService: HostListingsService) {}

  /** The pin is required, except with the test-only location bypass on. */
  private pinOrUndefined(latRaw: unknown, lngRaw: unknown, message: string) {
    if (this.hostListingsService.locationBypass && (blank(latRaw) || blank(lngRaw))) return undefined;
    return parsePin(latRaw, lngRaw, message);
  }

  // Registered before `:id`. Lets the web read the single server-side flag.
  @Get('capture-config')
  captureConfig() {
    return { success: true, locationBypass: this.hostListingsService.locationBypass };
  }

  @Get()
  async findMine(@CurrentUser() user: AuthUser) {
    const listings = await this.hostListingsService.findMine(user.userId);
    return { success: true, listings };
  }

  // Registered before the `:id` routes below — Nest/Express match routes in
  // declaration order, and "submit-full"/"save-draft"/"draft"/"media/..."
  // would otherwise be swallowed as an `:id` value.
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

  // "Save & exit" — no schema-completeness requirement, unlike submit-full.
  // `listingId` in the body is optional: omitted on the first save (a new
  // draft row is created), then echoed back by the client on every save
  // after so the same in-progress row is reused rather than forking.
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

  // The caller's most recent draft, if any — lets the wizard offer to
  // resume it on a different device/browser than the one it was saved on.
  // `listingId`, when passed, fetches that exact draft instead of "most recent" — see
  // findLatestDraft's doc comment for why those can disagree.
  @Get('draft')
  async latestDraft(@CurrentUser() user: AuthUser, @Query('listingId') listingId?: string) {
    const { listing } = await this.hostListingsService.findLatestDraft(user.userId, listingId);
    return { success: true, listing };
  }

  // Keyed off the caller only, not a listing id — the wizard is a one-page
  // form with no listing row until final submit, so photos are uploaded to the
  // host's own storage folder first and the resulting URLs ride along in the
  // submit-full/resubmit body, same as every other field.
  //
  // Photos are taken with the in-app camera and sent the moment they are taken:
  // each file comes with `captures[i]` (the device-reported lat/lng/accuracy and
  // capture time) and the listing pin (`lat`, `lng`) it is checked against.
  // `rooms` and `captures` are JSON arrays parallel to `files`.
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

  // Listing videos used to be uploaded here from the gallery. They are now
  // recorded with the in-app camera and go through media/walkthrough, so this
  // route accepts nothing: it stays only so an out-of-date client gets a
  // readable message instead of a 404.
  @ResponseMessage('Property videos can no longer be uploaded.')
  @Post('media/video')
  async uploadVideo() {
    throw new BadRequestException(
      'Property videos can no longer be uploaded. Record the walkthrough video with the in-app camera instead.',
    );
  }

  // The walkthrough video is recorded with the in-app camera and arrives with
  // the device-reported location at the end of the recording (`capture`, JSON)
  // plus the pinned lat/lng it is checked against. A pass only means "the
  // device said it was near the pin and the file looks like a video" — it never
  // looks at the footage, and the location is the client's word — so the
  // message says a person still reviews it, not that the location is
  // confirmed. A passed check's video is kept in Storage for that reviewer.
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
    // The upload is on disk before this runs; remove it on a request we refuse.
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
