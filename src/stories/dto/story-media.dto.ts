export const STORY_MEDIA_BUCKET = 'story-media';
export const STORY_MEDIA_MAX_BYTES = 5 * 1024 * 1024;

export type StoryMediaExt = 'jpg' | 'png' | 'webp';

export type StoryMediaResponse = { url: string };

/** Detects the image type from magic bytes; the client-declared mime type is never trusted. */
export function sniffStoryImage(
  buf: Buffer,
): { ext: StoryMediaExt; contentType: string } | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: 'jpg', contentType: 'image/jpeg' };
  }
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { ext: 'png', contentType: 'image/png' };
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { ext: 'webp', contentType: 'image/webp' };
  }
  return null;
}
