import { cancellationRefund } from './cancellation-refund.util';

const CHECK_IN = '2027-03-10'; // 2027-03-10T00:00+05:30
const at = (hoursBefore: number) => new Date(new Date(`${CHECK_IN}T00:00:00+05:30`).getTime() - hoursBefore * 3600_000);

describe('cancellationRefund', () => {
  it.each([
    // policy, hoursBefore, expected refund of 10_001 paid
    ['flexible', 24, 10001],
    ['flexible', 23, 5000],
    ['flexible', 0, 5000],
    ['moderate', 120, 10001],
    ['moderate', 119, 5000],
    ['moderate', 1, 5000],
    ['firm', 14 * 24, 10001],
    ['firm', 14 * 24 - 1, 5000],
    ['firm', 48, 5000],
    ['firm', 47, 0],
    ['firm', -5, 0],
  ])('%s at %sh before => %s', (policy, h, expected) => {
    const r = cancellationRefund(policy, CHECK_IN, at(h), 10001);
    expect(r.refundAmount).toBe(expected);
    expect(r.refundAmount + r.retainedAmount).toBe(10001);
  });

  it('falls back to moderate for an unknown policy and is integer-only', () => {
    expect(cancellationRefund('weird', CHECK_IN, at(10 * 24), 999).refundPct).toBe(100);
    expect(cancellationRefund(undefined, CHECK_IN, at(24), 999).refundAmount).toBe(499);
  });

  it('treats a non-positive paid amount as zero', () => {
    expect(cancellationRefund('flexible', CHECK_IN, at(100), -5)).toMatchObject({ refundAmount: 0, retainedAmount: 0 });
    expect(cancellationRefund('flexible', CHECK_IN, at(100), NaN).refundAmount).toBe(0);
  });
});
