import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import * as os from 'os';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { HostListingsService } from './host-listings.service';

interface UploadedMulterFile {
  buffer?: Buffer;
  path?: string;
  mimetype: string;
  size: number;
}

const PHOTO_MAX_BYTES = 8 * 1024 * 1024;
const VIDEO_MAX_BYTES = 150 * 1024 * 1024;

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

  @Get()
  async findMine(@CurrentUser() user: AuthUser) {
    const listings = await this.hostListingsService.findMine(user.userId);
    return { success: true, listings };
  }

  // Registered before the `:id` routes below — Nest/Express match routes in
  // declaration order, and "submit-full"/"media/..." would otherwise be
  // swallowed as an `:id` value.
  @Post('submit-full')
  async submitFull(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const { listingId, status } = await this.hostListingsService.submitFull(user.userId, body);
    return { success: true, listingId, status };
  }

  // Keyed off the caller only, not a listing id — the wizard is a one-page
  // form with no listing row until final submit, so photos/video are
  // uploaded to the host's own storage folder first and the resulting URLs
  // ride along in the submit-full/resubmit body, same as every other field.
  @Post('media/photos')
  @UseInterceptors(FilesInterceptor('files', 20, { limits: { fileSize: PHOTO_MAX_BYTES } }))
  async uploadPhotos(
    @CurrentUser() user: AuthUser,
    @Body('rooms') roomsJson: string,
    @UploadedFiles() files?: UploadedMulterFile[],
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('No files provided');
    }
    let rooms: string[];
    try {
      rooms = JSON.parse(roomsJson ?? '[]');
    } catch {
      throw new BadRequestException('rooms must be a JSON array');
    }
    const photos = await this.hostListingsService.uploadPhotos(user.userId, files, rooms);
    return { success: true, photos };
  }

  // Disk-backed (dest), not the in-memory buffering every other upload in
  // this codebase uses — a 150MB cap held fully in RAM per concurrent
  // request is a real resource risk at this size, unlike the ~5-30MB
  // avatar/dispute-evidence uploads. The service always deletes the temp
  // file after streaming it to Storage, success or failure.
  @Post('media/video')
  @UseInterceptors(FileInterceptor('video', { dest: os.tmpdir(), limits: { fileSize: VIDEO_MAX_BYTES } }))
  async uploadVideo(@CurrentUser() user: AuthUser, @UploadedFile() file?: UploadedMulterFile) {
    if (!file) {
      throw new BadRequestException('No file provided');
    }
    const videoUrl = await this.hostListingsService.uploadVideo(user.userId, file);
    return { success: true, videoUrl };
  }

  @Get(':id')
  async findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const listing = await this.hostListingsService.findMineById(user.userId, id);
    return { success: true, listing };
  }

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
