import { ConflictException, ForbiddenException } from '@nestjs/common';
import { BookingsService } from './bookings.service';

const ID = 'b1';
const HOST = 'h1';
const GUEST = 'g1';

function makeService(
  booking: Record<string, unknown> = {},
  paymentStatus = 'held',
) {
  const row = {
    status: 'confirmed',
    guest_id: GUEST,
    host_id: HOST,
    listing_id: 'l1',
    host_id_checked_at: null,
    host_id_checked_doc_type: null,
    ...booking,
  };
  const bookingsRepo = {
    findOne: jest.fn().mockResolvedValue(row),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const payments = { getForBooking: jest.fn().mockResolvedValue({ status: paymentStatus }) };
  const listingsRepo = {
    findOne: jest.fn().mockResolvedValue({ draft_data: { property_details: { title: 'Loft' } } }),
  };
  const stub = { findOne: jest.fn().mockResolvedValue(null), insert: jest.fn() };
  const notifications = { notify: jest.fn() };
  const service = new BookingsService(
    bookingsRepo as never,
    stub as never,
    listingsRepo as never,
    stub as never,
    stub as never,
    stub as never,
    stub as never,
    notifications as never,
    payments as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, bookingsRepo, notifications };
}

describe('BookingsService.hostIdCheck', () => {
  it('rejects non-host callers with 403', async () => {
    const { service, notifications } = makeService();
    await expect(service.hostIdCheck(GUEST, ID, 'aadhaar')).rejects.toBeInstanceOf(ForbiddenException);
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('rejects a non-confirmed booking with 409', async () => {
    const { service } = makeService({ status: 'pending' });
    await expect(service.hostIdCheck(HOST, ID, 'aadhaar')).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects when payment is not held with 409', async () => {
    const { service } = makeService({}, 'pending');
    await expect(service.hostIdCheck(HOST, ID, 'aadhaar')).rejects.toBeInstanceOf(ConflictException);
  });

  it('records the check and notifies the guest once', async () => {
    const { service, bookingsRepo, notifications } = makeService();
    const res = await service.hostIdCheck(HOST, ID, 'aadhaar');
    expect(res).toMatchObject({ success: true, hostIdCheckedDocType: 'aadhaar' });
    expect(res.hostIdCheckedAt).toBeInstanceOf(Date);
    expect(bookingsRepo.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: ID, status: 'confirmed' }),
      expect.objectContaining({ host_id_checked_doc_type: 'aadhaar', host_id_checked_at: expect.any(Date) }),
    );
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    expect(notifications.notify).toHaveBeenCalledWith(
      'booking.host_id_checked',
      GUEST,
      expect.objectContaining({ listingTitle: 'Loft', link: '/settings?tab=bookings' }),
    );
  });

  it('returns the existing attestation on repeat without notifying', async () => {
    const at = new Date('2026-11-01T00:00:00Z');
    const { service, bookingsRepo, notifications } = makeService({
      host_id_checked_at: at,
      host_id_checked_doc_type: 'passport',
    });
    await expect(service.hostIdCheck(HOST, ID, 'aadhaar')).resolves.toEqual({
      success: true,
      hostIdCheckedAt: at,
      hostIdCheckedDocType: 'passport',
    });
    expect(bookingsRepo.update).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });
});
