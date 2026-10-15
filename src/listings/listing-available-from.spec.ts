import { clampPastAvailableFrom, listingIssues } from './listing-schema';

describe('availableFrom in the past', () => {
  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-15T10:00:00Z'));
  });
  afterAll(() => jest.useRealTimers());

  it('moves a past date to today (IST) when editing an existing listing', () => {
    expect(clampPastAvailableFrom({ availableFrom: '2026-10-14' }, 'Asia/Kolkata').availableFrom).toBe('2026-10-15');
    expect(listingIssues(clampPastAvailableFrom({ availableFrom: '2026-10-14' }, 'Asia/Kolkata'), { timeZone: 'Asia/Kolkata' })).toEqual({});
  });

  it('uses the IST day, not the UTC day, near midnight', () => {
    jest.setSystemTime(new Date('2026-10-15T19:00:00Z')); // 00:30 on the 16th in India
    expect(clampPastAvailableFrom({ availableFrom: '2026-10-15' }, 'Asia/Kolkata').availableFrom).toBe('2026-10-16');
    jest.setSystemTime(new Date('2026-10-15T10:00:00Z'));
  });

  it('leaves today, a future date and a blank untouched', () => {
    for (const availableFrom of ['2026-10-15', '2026-12-01', '']) {
      const d = { availableFrom };
      expect(clampPastAvailableFrom(d, 'Asia/Kolkata')).toBe(d);
    }
  });

  it('still errors on a past date for a new submission (no clamp)', () => {
    expect(listingIssues({ availableFrom: '2026-10-14' }, { timeZone: 'Asia/Kolkata' }).availableFrom).toMatch(/today or a later date/);
  });
});
