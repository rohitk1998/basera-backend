import { captureCheckTrulyPassed } from './capture-evidence.util';

describe('captureCheckTrulyPassed', () => {
  it('is false for an empty draft', () => {
    expect(captureCheckTrulyPassed({})).toBe(false);
  });

  it('is false when the draft was approved past the camera-capture check', () => {
    expect(
      captureCheckTrulyPassed({ approval_overrides: [{ unmetChecks: ['Camera capture is submitted (x)'] }] }),
    ).toBe(false);
  });
});
