import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { SupabaseProvider } from '../auth/supabase.provider';
import {
  EXTENSION_BY_SIGNATURE_MIME_TYPE,
  SUPPORTED_SIGNATURE_MIME_TYPES,
  SupportedSignatureMimeType,
  detectSignatureMimeType,
} from '../common/file-signature.util';

const DEFAULT_BUCKET = 'kyc-documents';

const VERIFICATION_DOCUMENTS_BUCKET = 'verification-documents';
const VERIFICATION_DOCUMENT_MAX_BYTES = 8 * 1024 * 1024; // 8MB

export type VerificationDocumentFile = {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname: string;
};

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

  /**
   * Validates and uploads a private identity/PAN/bank verification
   * document. Server-side validation happens BEFORE anything touches
   * storage: mime allowlist, size cap, and a magic-number check that the
   * actual bytes match the claimed mimetype (never trust a
   * client-supplied Content-Type alone). The storage path is generated
   * here with randomUUID() — a client-supplied filename is never used as
   * part of the path, only optionally kept as metadata by the caller.
   *
   * Uploads to the private "verification-documents" bucket, path shaped
   * {userId}/{verificationType}/{randomUUID()}.{ext}.
   */
  async uploadVerificationDocument(
    userId: string,
    verificationType: string,
    file: VerificationDocumentFile,
  ): Promise<{ path: string }> {
    if (!file?.buffer || file.buffer.length === 0) {
      throw new InternalServerErrorException('Verification document upload expected an in-memory file.');
    }

    if (file.size > VERIFICATION_DOCUMENT_MAX_BYTES) {
      // A real 413, not a BadRequestException(400) whose body merely
      // claimed statusCode: 413 while Nest still returned HTTP 400.
      throw new PayloadTooLargeException('File too large. Maximum size is 8 MB.');
    }

    if (!(SUPPORTED_SIGNATURE_MIME_TYPES as readonly string[]).includes(file.mimetype)) {
      throw new BadRequestException('Unsupported file type. Use JPEG, PNG, WebP or PDF.');
    }

    const detected = detectSignatureMimeType(file.buffer);
    if (!detected || detected !== file.mimetype) {
      throw new BadRequestException(
        'File content does not match its declared type. Please upload a genuine JPEG, PNG, WebP or PDF file.',
      );
    }

    const ext = EXTENSION_BY_SIGNATURE_MIME_TYPE[detected as SupportedSignatureMimeType];
    const storagePath = `${userId}/${verificationType}/${randomUUID()}.${ext}`;

    const { error: uploadError } = await this.supabase.client.storage
      .from(VERIFICATION_DOCUMENTS_BUCKET)
      .upload(storagePath, file.buffer, { contentType: detected });

    if (uploadError) {
      throw new InternalServerErrorException('Upload failed. Please try again.');
    }

    return { path: storagePath };
  }

  /**
   * Signed, time-limited download URL for a private document — never use
   * getPublicUrl() for verification-documents. Callers are responsible
   * for authorization: a user may only request a signed URL for their
   * own document (check the path/row owner against the caller's userId),
   * while an admin route may request any.
   */
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
