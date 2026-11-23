import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { assertBookable, isBookable } from './booking-eligibility.util';
import { BookingEligibilityService } from './booking-eligibility.service';

describe('assertBookable', () => {
  it('allows only live, claimed, admin-enabled listings', () => {
    expect(isBookable({ status: 'live', is_discovered: false, booking_eligible: true })).toBe(true);
    expect(isBookable({ status: 'live', is_discovered: false, booking_eligible: false })).toBe(false);
    expect(isBookable({ status: 'in_review', is_discovered: false, booking_eligible: true })).toBe(false);
    expect(isBookable({ status: 'live', is_discovered: true, booking_eligible: true })).toBe(false);
    expect(isBookable(null)).toBe(false);
    expect(() => assertBookable({ status: 'live', booking_eligible: false })).toThrow(ForbiddenException);
    expect(() => assertBookable({ status: 'live', booking_eligible: true })).not.toThrow();
  });
});

describe('BookingEligibilityService', () => {
  const mk = (row: any) => {
    const listings = { findOne: jest.fn().mockResolvedValue(row), update: jest.fn() };
    const history = { record: jest.fn() };
    const ls = { bumpSearchCacheVersion: jest.fn() };
    return { svc: new BookingEligibilityService(listings as any, history as any, ls as any), listings, history, ls };
  };

  it('validates the body', async () => {
    const { svc } = mk({ id: 'x', status: 'live' });
    await expect(svc.set('x', 'admin', { eligible: 'yes' })).rejects.toThrow(BadRequestException);
  });

  it('refuses to enable a non-live listing', async () => {
    const { svc, listings } = mk({ id: 'x', status: 'in_review', is_discovered: false, booking_eligible: false });
    await expect(svc.set('x', 'admin', { eligible: true })).rejects.toThrow(ConflictException);
    expect(listings.update).not.toHaveBeenCalled();
  });

  it('enables, audits and busts the search cache', async () => {
    const { svc, listings, history, ls } = mk({ id: 'x', status: 'live', is_discovered: false, booking_eligible: false });
    await expect(svc.set('x', 'admin1', { eligible: true, reason: 'kyc ok' })).resolves.toEqual({ listingId: 'x', bookingEligible: true });
    expect(listings.update).toHaveBeenCalledWith({ id: 'x' }, expect.objectContaining({ booking_eligible: true }));
    expect(history.record).toHaveBeenCalledWith(expect.objectContaining({ to: 'booking_enabled', actorId: 'admin1' }));
    expect(ls.bumpSearchCacheVersion).toHaveBeenCalled();
  });

  it('is a no-op when unchanged', async () => {
    const { svc, listings } = mk({ id: 'x', status: 'live', booking_eligible: true });
    await svc.set('x', 'a', { eligible: true });
    expect(listings.update).not.toHaveBeenCalled();
  });
});
