import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { MAX_IMAGE_PIXELS, MIN_IMAGE_SIDE, REENCODE_MAX_SIDE } from './host-verification.constants';

export type SniffedImage = { mime: 'image/jpeg' | 'image/png'; ext: 'jpg' | 'png' };

/** Trust the bytes, not the client-declared mimetype. */
export function sniffImage(buf: Buffer): SniffedImage | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length >= 8 && png.every((b, i) => buf[i] === b)) {
    return { mime: 'image/png', ext: 'png' };
  }
  return null;
}

/**
 * Decodes and re-encodes every upload as a fresh JPEG: strips EXIF/ICC/GPS and any appended payload,
 * applies orientation, caps dimensions, and refuses anything undecodable or absurdly large (the
 * pixel limit is enforced by sharp before the bitmap is allocated).
 */
export async function reencodeToJpeg(buf: Buffer, label: string): Promise<{ buffer: Buffer; width: number; height: number }> {
  // Loaded lazily so a broken native binary fails this call (clearly), not application boot.
  let sharp: typeof import('sharp');
  try {
    sharp = (await import('sharp')).default;
  } catch {
    throw new ServiceUnavailableException('Image processing is temporarily unavailable.');
  }
  try {
    const { data, info } = await sharp(buf, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'error' })
      .rotate()
      .resize({ width: REENCODE_MAX_SIDE, height: REENCODE_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 85 })
      .toBuffer({ resolveWithObject: true });
    if (Math.min(info.width, info.height) < MIN_IMAGE_SIDE) {
      throw new BadRequestException(`${label} is too small. Move closer and retake it.`);
    }
    return { buffer: data, width: info.width, height: info.height };
  } catch (err) {
    if (err instanceof BadRequestException) throw err;
    throw new BadRequestException(`${label} could not be read as an image. Please retake it.`);
  }
}
