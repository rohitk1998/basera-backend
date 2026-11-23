import { NotFoundException } from '@nestjs/common';
import { CalendarSyncService } from './calendar-sync.service';

describe('ICS export feed', () => {
  const mk = (token: string, bookings: any[]) => {
    const qb: any = {
      select: () => qb, where: () => qb,
      andWhere: jest.fn(() => qb),
      getMany: async () => bookings,
    };
    const svc = new CalendarSyncService(
      { findOne: async () => ({ listing_id: 'l', export_token: token }) } as any,
      {} as any,
      { createQueryBuilder: () => qb } as any,
      {} as any,
      {} as any,
    );
    return { svc, qb };
  };

  it('rejects a wrong token', async () => {
    await expect(mk('secret', []).svc.buildFeed('l', 'nope')).rejects.toThrow(NotFoundException);
  });

  it('exports dates only: no requested holds in the filter, no guest PII in the body', async () => {
    const { svc, qb } = mk('secret', [
      { id: 'b1', move_in: '2030-01-01', move_out: '2030-01-08', actual_move_out: null, status: 'confirmed', guest_id: 'g', guest_name: 'Asha' },
    ]);
    const ics = await svc.buildFeed('l', 'secret');
    expect(ics).toContain('DTSTART;VALUE=DATE:20300101');
    expect(ics).toContain('DTEND;VALUE=DATE:20300108');
    expect(ics).not.toMatch(/Asha|guest/i);
    const statuses = (qb.andWhere.mock.calls[0][1] as any).statuses as string[];
    expect(statuses).not.toContain('requested');
    expect(statuses).toContain('confirmed');
  });
});
