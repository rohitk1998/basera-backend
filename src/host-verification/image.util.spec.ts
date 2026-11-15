import { sniffImage } from './image.util';

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
