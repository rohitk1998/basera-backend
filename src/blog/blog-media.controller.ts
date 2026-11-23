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
import { AdminGuard } from '../auth/admin.guard';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { SupabaseProvider } from '../auth/supabase.provider';
import {
  STORY_MEDIA_MAX_BYTES,
  sniffStoryImage,
} from '../stories/dto/story-media.dto';

export const BLOG_MEDIA_BUCKET = 'blog-media';

type UploadedImage = { buffer?: Buffer; size: number };

@Controller('api/admin/blog')
export class BlogMediaController {
  constructor(private readonly supabase: SupabaseProvider) {}

  @UseGuards(AdminGuard)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ResponseMessage('Image uploaded.')
  @Post('media')
  @HttpCode(201)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: STORY_MEDIA_MAX_BYTES, files: 1 } }),
  )
  async upload(@UploadedFile() file: UploadedImage | undefined): Promise<{ url: string }> {
    if (!file?.buffer) throw new BadRequestException('Choose an image to upload.');
    if (file.size > STORY_MEDIA_MAX_BYTES) {
      throw new PayloadTooLargeException('Image too large. Maximum size is 5 MB.');
    }
    const kind = sniffStoryImage(file.buffer);
    if (!kind) throw new BadRequestException('Images must be JPEG, PNG or WebP.');

    const path = `${randomUUID()}.${kind.ext}`;
    const bucket = this.supabase.client.storage.from(BLOG_MEDIA_BUCKET);
    const { error } = await bucket.upload(path, file.buffer, { contentType: kind.contentType });
    if (error) throw new InternalServerErrorException('Upload failed. Please try again.');
    return { url: bucket.getPublicUrl(path).data.publicUrl };
  }
}
