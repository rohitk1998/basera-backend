import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdminBookingsService, deriveActions } from './admin-bookings.service';

describe('deriveActions', () => {
  it('offers dispute resolution only for disputed bookings', () => {
    expect(deriveActions('confirmed', null).find((a) => a.id === 'resolve_dispute')?.available).toBe(false);
    expect(deriveActions('disputed', 'escalated').find((a) => a.id === 'resolve_dispute')?.available).toBe(true);
  });
  it('mirrors the matrix for cancel and never marks terminal states cancellable', () => {
    expect(deriveActions('confirmed', null).find((a) => a.id === 'cancel')?.available).toBe(true);
    expect(deriveActions('completed', null).find((a) => a.id === 'cancel')?.available).toBe(false);
    expect(deriveActions('checked_in', null).find((a) => a.id === 'cancel')?.available).toBe(false);
    expect(deriveActions('disputed', 'escalated').find((a) => a.id === 'cancel')?.available).toBe(false);
  });
});

describe('AdminBookingsService.cancel', () => {
  const mk = (rows: any[]) => {
    const ds: any = { query: jest.fn().mockResolvedValue(rows) };
    const bookings: any = { resolveDispute: jest.fn().mockResolvedValue({ ok: true }) };
    return { svc: new AdminBookingsService(ds, bookings), ds, bookings };
  };
  it('404 for unknown booking', async () => {
    await expect(mk([]).svc.cancel('a', 'b', 'because', 0)).rejects.toBeInstanceOf(NotFoundException);
  });
  it('non-disputed bookings call adminCancel with the chosen refundMode (default policy)', async () => {
    const { svc, bookings } = mk([{ status: 'confirmed' }]);
    (bookings as any).adminCancel = jest.fn().mockResolvedValue({ success: true, status: 'cancelled' });
    await svc.cancel('admin', 'bk', 'reason text', undefined, 'none');
    expect((bookings as any).adminCancel).toHaveBeenCalledWith('admin', 'bk', { reason: 'reason text', refundMode: 'none' });
    await svc.cancel('admin', 'bk', 'reason text');
    expect((bookings as any).adminCancel).toHaveBeenLastCalledWith('admin', 'bk', { reason: 'reason text', refundMode: 'policy' });
    expect(bookings.resolveDispute).not.toHaveBeenCalled();
  });
  it('propagates the 409 from adminCancel for completed bookings', async () => {
    const { svc, bookings } = mk([{ status: 'completed' }]);
    (bookings as any).adminCancel = jest.fn().mockRejectedValue(new ConflictException('no'));
    await expect(svc.cancel('a', 'b', 'because')).rejects.toBeInstanceOf(ConflictException);
  });
  it('delegates a disputed booking to resolveDispute', async () => {
    const { svc, bookings } = mk([{ status: 'disputed' }]);
    await svc.cancel('admin', 'bk', 'reason text', 500);
    expect(bookings.resolveDispute).toHaveBeenCalledWith('admin', 'bk', 500, 'reason text');
  });
  it('requires amountToGuest for disputes', async () => {
    await expect(mk([{ status: 'disputed' }]).svc.cancel('a', 'b', 'because')).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('AdminBookingsService.list', () => {
  it('parameterises filters and never interpolates user input', async () => {
    const ds: any = { query: jest.fn(async (sql: string) => (sql.includes('to_regclass') ? [{ ok: true }] : sql.includes('count(*)') ? [{ n: 0 }] : [])) };
    const svc = new AdminBookingsService(ds, {} as any);
    await svc.list({ q: "x'; drop table bookings;--" });
    const calls = ds.query.mock.calls.map((c: any[]) => c[0] as string);
    expect(calls.some((s) => s.includes('drop table'))).toBe(false);
  });
  it('normalises a reference query', async () => {
    const ds: any = { query: jest.fn(async (sql: string) => (sql.includes('to_regclass') ? [{ ok: false }] : sql.includes('count(*)') ? [{ n: 0 }] : [])) };
    await new AdminBookingsService(ds, {} as any).list({ q: 'rb7k3' });
    const countCall = ds.query.mock.calls.find((c: any[]) => String(c[0]).includes('count(*)'));
    expect(countCall[1][7]).toBe('RB-7K3');
  });
});
