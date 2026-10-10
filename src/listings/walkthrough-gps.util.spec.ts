import { assessWalkthroughMetadata, isUsableGps } from './walkthrough-gps.util';

const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
const phoneVideo = {
  ImageWidth: 1920,
  ImageHeight: 1080,
  CreateDate: '2026:09:29 10:00:00',
  Make: 'Apple',
  Model: 'iPhone 15',
};

describe('assessWalkthroughMetadata', () => {
  it('accepts a recent camera file with nothing to note', () => {
    const r = assessWalkthroughMetadata(phoneVideo, 30, NOW);
    expect(r.failure).toBeUndefined();
    expect(r.warnings).toEqual([]);
    expect(r.recordedAt).toBe('2026-09-29T10:00:00.000Z');
  });

  it('refuses a file with no video picture', () => {
    expect(assessWalkthroughMetadata({ CreateDate: phoneVideo.CreateDate }, 30, NOW).failure).toMatch(/no video picture/);
  });

  it('refuses a recording date in the future, but not a few hours of clock skew', () => {
    expect(assessWalkthroughMetadata({ ...phoneVideo, CreateDate: '2027:01:01 00:00:00' }, 30, NOW).failure).toMatch(/future/);
    expect(assessWalkthroughMetadata({ ...phoneVideo, CreateDate: '2026:09:30 18:00:00' }, 30, NOW).failure).toBeUndefined();
  });

  it('treats the empty date a container writes as no date, and notes it', () => {
    const r = assessWalkthroughMetadata({ ...phoneVideo, CreateDate: '0000:00:00 00:00:00' }, 30, NOW);
    expect(r.failure).toBeUndefined();
    expect(r.warnings).toContain('The file carries no recording date.');
  });

  it('notes an old recording, editing software, a missing camera and an absurd length', () => {
    const r = assessWalkthroughMetadata(
      { ImageWidth: 1280, ImageHeight: 720, CreateDate: '2026:01:01 00:00:00', Encoder: 'Lavf58.76.100' },
      45 * 60,
      NOW,
    );
    expect(r.warnings).toHaveLength(4);
  });
});

describe('assessWalkthroughMetadata for an in-app (MediaRecorder) capture', () => {
  // MediaRecorder writes no date and no camera name, and the capture time is
  // checked separately, so those three observations must not fire on every clip.
  const recorder = { ImageWidth: 1280, ImageHeight: 720 };

  it('does not warn about the missing date, camera name or an old date', () => {
    expect(assessWalkthroughMetadata(recorder, 30, NOW, { capturedInApp: true }).warnings).toEqual([]);
    expect(assessWalkthroughMetadata({ ...recorder, CreateDate: '2026:01:01 00:00:00' }, 30, NOW, { capturedInApp: true }).warnings).toEqual([]);
  });

  it('still refuses a file with no video picture and still notes editing software and absurd lengths', () => {
    expect(assessWalkthroughMetadata({}, 30, NOW, { capturedInApp: true }).failure).toMatch(/no video picture/);
    const r = assessWalkthroughMetadata({ ...recorder, Encoder: 'Lavf58' }, 45 * 60, NOW, { capturedInApp: true });
    expect(r.warnings).toHaveLength(2);
  });
});

describe('isUsableGps', () => {
  it('rejects null island, out-of-range and non-numeric tags', () => {
    expect(isUsableGps(0, 0)).toBe(false);
    expect(isUsableGps(95, 10)).toBe(false);
    expect(isUsableGps('32.2', '76.3')).toBe(false);
    expect(isUsableGps(undefined, 76.3)).toBe(false);
  });
  it('accepts a real coordinate', () => {
    expect(isUsableGps(32.219, 76.3234)).toBe(true);
  });
});
