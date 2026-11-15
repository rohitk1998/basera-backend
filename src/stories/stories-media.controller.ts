import {
  BadRequestException,
  Controller,
  HttpCode,
  InternalServerErrorException,
  PayloadTooLargeException,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { randomUUID } from 'crypto';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { SupabaseProvider } from '../auth/supabase.provider';
import type { AuthUser } from '../auth/types';
import {
  STORY_MEDIA_BUCKET,
  STORY_MEDIA_MAX_BYTES,
  sniffStoryImage,
  type StoryMediaResponse,
} from './dto/story-media.dto';

type UploadedImage = { buffer?: Buffer; size: number };

@Controller('api/stories')
export class StoriesMediaController {
  constructor(private readonly supabase: SupabaseProvider) {}

  @UseGuards(AuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Post('media')
  @HttpCode(201)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: STORY_MEDIA_MAX_BYTES, files: 1 } }),
  )
  async upload(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: UploadedImage | undefined,
  ): Promise<StoryMediaResponse> {
    if (!file?.buffer) throw new BadRequestException('Choose a photo to upload.');
    if (file.size > STORY_MEDIA_MAX_BYTES) {
      throw new PayloadTooLargeException('Photo too large. Maximum size is 5 MB.');
    }
    const kind = sniffStoryImage(file.buffer);
    if (!kind) {
      throw new BadRequestException('Photos must be JPEG, PNG or WebP images.');
    }

    const path = `${user.userId}/${randomUUID()}.${kind.ext}`;
    const bucket = this.supabase.client.storage.from(STORY_MEDIA_BUCKET);
    const { error } = await bucket.upload(path, file.buffer, {
      contentType: kind.contentType,
    });
    if (error) {
      throw new InternalServerErrorException('Upload failed. Please try again.');
    }
    return { url: bucket.getPublicUrl(path).data.publicUrl };
  }
}
