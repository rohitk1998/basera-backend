// Shared magic-number (file signature) verification, used by BOTH
// storage upload validation (storage.service.ts) and document analysis
// (verification/document-analysis.service.ts) — kept in exactly one
// place rather than duplicated, per project convention.
//
// A client-supplied Content-Type / mimetype is never trusted alone: this
// inspects the actual leading bytes of the buffer and confirms they
// match one of the file types this app accepts, regardless of what the
// caller claims the file is.

export const SUPPORTED_SIGNATURE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;

export type SupportedSignatureMimeType = (typeof SUPPORTED_SIGNATURE_MIME_TYPES)[number];

/**
 * Inspects the actual bytes of `buffer` and returns the file type its
 * magic number indicates, or null if it doesn't match any supported
 * signature. This is independent of any claimed mimetype/extension.
 *
 *  - JPEG:  FF D8 FF
 *  - PNG:   89 50 4E 47
 *  - PDF:   25 50 44 46  ("%PDF")
 *  - WebP:  "RIFF" (bytes 0-3) + "WEBP" ASCII at offset 8, inside a RIFF container
 */
export function detectSignatureMimeType(buffer: Buffer): SupportedSignatureMimeType | null {
  if (!buffer || buffer.length < 12) {
    // Too short to contain any of the signatures below (WebP's needs 12
    // bytes: 4-byte RIFF header + 4-byte size + 4-byte "WEBP" marker).
    return null;
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }

  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
    return 'application/pdf';
  }

  const isRiff =
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46; // "RIFF"
  const isWebp =
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50; // "WEBP"
  if (isRiff && isWebp) {
    return 'image/webp';
  }

  return null;
}

/**
 * True only if the buffer's real signature matches the claimed mimetype
 * AND that mimetype is one of the types this app accepts. Use this for
 * upload validation — reject anything that returns false regardless of
 * the claimed Content-Type/extension.
 */
export function signatureMatchesClaimedMimeType(buffer: Buffer, claimedMimeType: string): boolean {
  const detected = detectSignatureMimeType(buffer);
  return detected !== null && detected === claimedMimeType;
}

export const EXTENSION_BY_SIGNATURE_MIME_TYPE: Record<SupportedSignatureMimeType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};
