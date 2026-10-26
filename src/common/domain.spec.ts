import { agreeTerms } from './domain';

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
