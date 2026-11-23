import { loadBufferDays, widenedWindow } from './buffer-days.util';

describe('buffer-days.util', () => {
  it('returns 0 without a db, without the table, or on error', async () => {
    expect(await loadBufferDays(undefined, 'l')).toBe(0);
    expect(await loadBufferDays({ query: jest.fn().mockResolvedValue([{ ok: false }]) }, 'l')).toBe(0);
    expect(await loadBufferDays({ query: jest.fn().mockRejectedValue(new Error('x')) }, 'l')).toBe(0);
  });
  it('clamps the stored value', async () => {
    const q = jest.fn().mockResolvedValueOnce([{ ok: true }]).mockResolvedValueOnce([{ buffer_days: 9 }]);
    expect(await loadBufferDays({ query: q }, 'l')).toBe(3);
  });
  it('widens the window by the max buffer', () => {
    expect(widenedWindow('2026-12-10', '2026-12-12')).toEqual({ start: '2026-12-07', end: '2026-12-15' });
  });
});
