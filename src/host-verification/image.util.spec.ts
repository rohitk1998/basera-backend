import { sniffImage, reencodeToJpeg } from './image.util';

describe('sniffImage', () => {
  it('recognises JPEG and PNG by their bytes', () => {
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]))).toEqual({ mime: 'image/jpeg', ext: 'jpg' });
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toEqual({
      mime: 'image/png',
      ext: 'png',
    });
  });

  it('rejects everything else, whatever the client claimed', () => {
    expect(sniffImage(Buffer.from('GIF89a'))).toBeNull();
    expect(sniffImage(Buffer.from('<svg></svg>'))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });
});

// These need the sharp native binary (libvips). They skip, loudly, where it cannot load.
const sharpLoads = (() => {
  try {
    require('sharp');
    return true;
  } catch {
    return false;
  }
})();

(sharpLoads ? describe : describe.skip)('reencodeToJpeg (real sharp)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sharp = () => require('sharp') as typeof import('sharp');
  const make = (size: number, fmt: 'jpeg' | 'png' = 'jpeg') =>
    sharp()({ create: { width: size, height: size, channels: 3, background: '#336699' } })[fmt]().toBuffer();

  it('rejects an undecodable truncated stub', async () => {
    await expect(reencodeToJpeg(Buffer.from([0xff, 0xd8, 0xff]), 'x')).rejects.toThrow(/could not be read/);
  });
  it('re-encodes to a fresh JPEG and strips EXIF', async () => {
    const withExif = await sharp()(await make(400)).withExif({ IFD0: { Copyright: 'secret-gps-marker' } }).jpeg().toBuffer();
    expect(withExif.includes(Buffer.from('secret-gps-marker'))).toBe(true);
    const out = await reencodeToJpeg(withExif, 'x');
    expect(out.buffer.includes(Buffer.from('secret-gps-marker'))).toBe(false);
    expect(sniffImage(out.buffer)?.mime).toBe('image/jpeg');
  });
  it('normalises PNG to JPEG and refuses too-small images', async () => {
    expect(sniffImage((await reencodeToJpeg(await make(300, 'png'), 'x')).buffer)?.mime).toBe('image/jpeg');
    await expect(reencodeToJpeg(await make(40), 'x')).rejects.toThrow(/too small/);
  });
  it('refuses a decompression bomb (pixel cap) before decoding', async () => {
    const bomb = await sharp()({ create: { width: 7000, height: 7000, channels: 3, background: '#fff' } })
      .png({ compressionLevel: 9 })
      .toBuffer();
    await expect(reencodeToJpeg(bomb, 'x')).rejects.toThrow(/could not be read/);
  });
});
