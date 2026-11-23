import { ConflictException } from '@nestjs/common';
import { assertTransition, BOOKING_TRANSITIONS, canTransition } from './booking-transitions';

describe('booking transition matrix', () => {
  it('allows the happy path', () => {
    const path = ['requested', 'confirmed', 'checked_in', 'checked_out', 'completed'];
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i], path[i + 1])).toBe(true);
  });

  it('allows the documented side exits', () => {
    expect(canTransition('requested', 'declined')).toBe(true);
    expect(canTransition('requested', 'expired')).toBe(true);
    expect(canTransition('confirmed', 'cancelled')).toBe(true);
    expect(canTransition('confirmed', 'expired')).toBe(true);
    expect(canTransition('checked_in', 'disputed')).toBe(true);
    expect(canTransition('disputed', 'completed')).toBe(true);
  });

  it.each([
    ['requested', 'checked_in'],
    ['requested', 'completed'],
    ['confirmed', 'requested'],
    ['confirmed', 'declined'],
    ['checked_in', 'cancelled'],
    ['checked_in', 'confirmed'],
    ['disputed', 'checked_out'],
    ['disputed', 'cancelled'],
    ['checked_out', 'disputed'],
  ])('rejects %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to)).toThrow(ConflictException);
  });

  it('has no way out of a terminal state', () => {
    for (const t of ['completed', 'declined', 'cancelled', 'expired']) {
      expect(BOOKING_TRANSITIONS[t as keyof typeof BOOKING_TRANSITIONS]).toEqual([]);
    }
  });

  it('rejects unknown statuses and self-transitions', () => {
    expect(canTransition('bogus', 'confirmed')).toBe(false);
    expect(canTransition('confirmed', 'bogus')).toBe(false);
    for (const from of Object.keys(BOOKING_TRANSITIONS)) expect(canTransition(from, from)).toBe(false);
  });

  it('only targets statuses that exist as keys', () => {
    const keys = new Set(Object.keys(BOOKING_TRANSITIONS));
    for (const targets of Object.values(BOOKING_TRANSITIONS)) for (const t of targets) expect(keys.has(t)).toBe(true);
  });

  describe('offer flow', () => {
    it('allows requested -> host_review -> offered -> awaiting_payment -> confirmed', () => {
      const path = ['requested', 'host_review', 'offered', 'awaiting_payment', 'confirmed'];
      for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i], path[i + 1])).toBe(true);
    });
    it('lets the host skip host_review and keeps the legacy approve edge', () => {
      expect(canTransition('requested', 'offered')).toBe(true);
      expect(canTransition('requested', 'confirmed')).toBe(true);
      expect(canTransition('host_review', 'confirmed')).toBe(true);
    });
    it('every pre-payment state can expire or be cancelled', () => {
      for (const s of ['requested', 'host_review', 'offered', 'awaiting_payment']) {
        expect(canTransition(s, 'expired')).toBe(true);
        expect(canTransition(s, 'cancelled')).toBe(true);
      }
    });
    it.each([
      ['offered', 'confirmed'],
      ['offered', 'host_review'],
      ['awaiting_payment', 'offered'],
      ['awaiting_payment', 'declined'],
      ['awaiting_payment', 'checked_in'],
      ['confirmed', 'awaiting_payment'],
      ['host_review', 'requested'],
    ])('rejects %s -> %s (payment cannot be skipped)', (from, to) => {
      expect(canTransition(from, to)).toBe(false);
    });
  });
});
