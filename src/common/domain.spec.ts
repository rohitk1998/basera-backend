import { MIN_STAY_NIGHTS, agreeTerms, effectiveMinStay } from './domain';

describe('agreeTerms', () => {
  const rate = 2600;

  it('charges a 61-day stay as 2 whole months, not 61/30 of one', () => {
    const t = agreeTerms(rate, 10, 30, 61);
    expect(t.months).toBe(2);
    expect(t.totalRent).toBe(109200);
    expect(t.deposit).toBe(54600);
    expect(t.dueAtMoveIn).toBe(163800);
  });

  it('prices a 1-month stay as one month', () => {
    expect(agreeTerms(rate, 10, 30, 30).totalRent).toBe(54600);
    expect(agreeTerms(rate, 10, 30, 31).months).toBe(1);
  });

  it('keeps per-day pricing (and the weekly discount) for stays under a month', () => {
    const t = agreeTerms(rate, 10, 30, 10);
    expect(t.months).toBeNull();
    expect(t.totalRent).toBe(Math.round(rate * 10 * 0.9));
    expect(t.deposit).toBe(0);
  });
});

describe('minimum stay', () => {
  const rate = 2600;

  it('floors the guest-facing minimum at 7 nights and honours a higher host minimum', () => {
    expect(MIN_STAY_NIGHTS).toBe(7);
    expect(effectiveMinStay(undefined)).toBe(7);
    expect(effectiveMinStay(null)).toBe(7);
    expect(effectiveMinStay(1)).toBe(7);
    expect(effectiveMinStay(7)).toBe(7);
    expect(effectiveMinStay(30)).toBe(30);
  });

  it('prices 7 to 27 nights through the weekly path with no deposit', () => {
    for (const days of [7, 14, 27]) {
      const t = agreeTerms(rate, 10, 30, days);
      expect(t.months).toBeNull();
      expect(t.deposit).toBe(0);
      expect(t.totalRent).toBe(Math.round(rate * days * 0.9));
      expect(t.dueAtMoveIn).toBe(t.totalRent);
    }
  });

  it('switches to monthly pricing and a deposit from 28 nights', () => {
    const t = agreeTerms(rate, 10, 30, 28);
    expect(t.months).toBe(1);
    expect(t.deposit).toBe(Math.round(rate * 30 * 0.7));
  });
});
