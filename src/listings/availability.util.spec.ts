import { bufferRange, clampBuffer, findConflicts, hasConflict, rangesOverlap } from './availability.util';

const occ = [{ start: '2030-03-10', end: '2030-03-15' }];

describe('availability util', () => {
  it('clamps the buffer to 0-3', () => {
    expect([clampBuffer(-1), clampBuffer(9), clampBuffer(2), clampBuffer('x')]).toEqual([0, 3, 2, 0]);
  });

  it('half-open overlap: back-to-back stays do not clash with no buffer', () => {
    expect(rangesOverlap(occ[0], { start: '2030-03-15', end: '2030-03-20' })).toBe(false);
    expect(hasConflict(occ, { start: '2030-03-15', end: '2030-03-20' }, 0)).toBe(false);
    expect(hasConflict(occ, { start: '2030-03-14', end: '2030-03-20' }, 0)).toBe(true);
  });

  it('a buffer blocks the turnover days on both sides', () => {
    expect(bufferRange(occ[0], 2)).toEqual({ start: '2030-03-08', end: '2030-03-17' });
    expect(hasConflict(occ, { start: '2030-03-15', end: '2030-03-20' }, 1)).toBe(true);
    expect(hasConflict(occ, { start: '2030-03-16', end: '2030-03-20' }, 1)).toBe(false);
    expect(hasConflict(occ, { start: '2030-03-05', end: '2030-03-10' }, 1)).toBe(true);
  });

  it('returns the clashing ranges and ignores an invalid request', () => {
    expect(findConflicts(occ, { start: '2030-03-12', end: '2030-03-13' }, 0)).toEqual(occ);
    expect(findConflicts(occ, { start: '2030-03-13', end: '2030-03-12' }, 0)).toEqual([]);
  });
});
