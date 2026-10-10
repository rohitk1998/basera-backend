import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { SupabaseProvider } from '../auth/supabase.provider';
import {
  commonsFileTitle,
  downloadImage,
  fetchCommonsImage,
} from './external-sources';

/** Same public bucket the homepage destination photos already live in. */
const BUCKET = 'basera_assets';
const PREFIX = 'attractions';
const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * Copies an openly licensed Wikimedia Commons photo into our own storage, so
 * guests load it from Supabase and never from Wikimedia. Returns null — never
 * throws — when the file is missing, unlicensed or fails to download: an
 * attraction without a photo still shows, with a placeholder.
 */
@Injectable()
export class AttractionImagesService {
  private readonly logger = new Logger(AttractionImagesService.name);
  private bucketChecked = false;

  constructor(private readonly supabase: SupabaseProvider) {}

  async copyFromCommons(
    fileOrUrl: string,
    slug: string,
  ): Promise<{ url: string; credit: string } | null> {
    const title = commonsFileTitle(fileOrUrl);
    if (!title) return null;
    try {
      const image = await fetchCommonsImage(title);
      if (!image) {
        this.logger.log(`Skipped ${title}: no usable rendition or license`);
        return null;
      }
      const file = await downloadImage(image.url);
      if (!file) return null;
      const url = await this.upload(slug, file.buffer, file.contentType);
      return url ? { url, credit: image.credit } : null;
    } catch (err) {
      this.logger.warn(`Image for ${slug} failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async upload(
    slug: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<string | null> {
    const storage = this.supabase.client.storage;
    if (!this.bucketChecked) {
      const { data } = await storage.listBuckets();
      if (data && !data.some((b) => b.name === BUCKET)) {
        await storage.createBucket(BUCKET, { public: true });
      }
      this.bucketChecked = true;
    }
    // A fresh name per upload, so a replaced photo is never served stale from a CDN cache.
    const path = `${PREFIX}/${slug}-${randomUUID().slice(0, 8)}.${EXT[contentType] ?? 'jpg'}`;
    const { error } = await storage.from(BUCKET).upload(path, buffer, {
      contentType,
      cacheControl: '31536000',
      upsert: false,
    });
    if (error) {
      this.logger.warn(`Upload ${path} failed: ${error.message}`);
      return null;
    }
    return storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  }
}
