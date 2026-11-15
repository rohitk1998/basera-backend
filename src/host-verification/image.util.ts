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
