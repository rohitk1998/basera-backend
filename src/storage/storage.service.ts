import { BadRequestException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { SupabaseProvider } from '../auth/supabase.provider';

const DEFAULT_BUCKET = 'kyc-documents';

// Buckets a client may mint a signed upload URL for. Everything else (public buckets, the private
// host-verification bucket) is written only by server code after validation.
const CLIENT_UPLOAD_BUCKETS: readonly string[] = [DEFAULT_BUCKET];

const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

@Injectable()
export class StorageService {
  constructor(private readonly supabase: SupabaseProvider) {}

  async createSignedUploadUrl(userId: string, fileName: string, bucket?: string) {
    const target = bucket || DEFAULT_BUCKET;
    if (!CLIENT_UPLOAD_BUCKETS.includes(target)) {
      throw new BadRequestException('This bucket does not accept direct uploads.');
    }
    if (!SAFE_FILE_NAME.test(fileName) || fileName.includes('..')) {
      throw new BadRequestException('Invalid file name.');
    }

    const { data, error } = await this.supabase.client.storage
      .from(target)
      .createSignedUploadUrl(`${userId}/${fileName}`);

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return { success: true, url: data.signedUrl, path: data.path };
  }

  async createSignedDownloadUrl(
    bucket: string,
    path: string,
    expiresInSeconds = 300,
  ): Promise<string> {
    const { data, error } = await this.supabase.client.storage
      .from(bucket)
      .createSignedUrl(path, expiresInSeconds);

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return data.signedUrl;
  }

  async uploadPrivate(bucket: string, path: string, body: Buffer, contentType: string): Promise<void> {
    const { error } = await this.supabase.client.storage
      .from(bucket)
      .upload(path, body, { contentType, upsert: false });
    if (error) {
      throw new InternalServerErrorException(`Upload failed: ${error.message}`);
    }
  }

  async copy(bucket: string, fromPath: string, toBucket: string, toPath: string): Promise<void> {
    const { data, error } = await this.supabase.client.storage.from(bucket).download(fromPath);
    if (error || !data) {
      throw new InternalServerErrorException(`Could not read ${fromPath}`);
    }
    const body = Buffer.from(await data.arrayBuffer());
    const { error: upErr } = await this.supabase.client.storage
      .from(toBucket)
      .upload(toPath, body, { contentType: data.type || 'image/jpeg', upsert: true });
    if (upErr) {
      throw new InternalServerErrorException(`Could not write ${toPath}`);
    }
  }

  /** Hard delete. Throws if the storage API reports an error so callers can retry the purge. */
  async remove(bucket: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const { error } = await this.supabase.client.storage.from(bucket).remove(paths);
    if (error) {
      throw new InternalServerErrorException(`Delete failed: ${error.message}`);
    }
  }
}
