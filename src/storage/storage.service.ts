import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { SupabaseProvider } from '../auth/supabase.provider';

const DEFAULT_BUCKET = 'kyc-documents';

@Injectable()
export class StorageService {
  constructor(private readonly supabase: SupabaseProvider) {}

  async createSignedUploadUrl(userId: string, fileName: string, bucket?: string) {
    const { data, error } = await this.supabase.client.storage
      .from(bucket || DEFAULT_BUCKET)
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
}
