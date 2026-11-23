import { BadRequestException, ConflictException, ForbiddenException, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { BookingEntity, InquiryEntity, InquiryEventEntity, InquiryMessageEntity, ListingEntity } from '../entities';
import { BOOKING_ERROR_CODES } from '../bookings/bookings.service';
import { candidateReadiness } from './candidate-readiness';
import { InquiryOwnerRequestService } from './inquiry-owner-request.service';

const GUEST = 'g1';
const HOST = 'h1';

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x), (_k, v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v) ? new Date(v) : v));
}

/** Tiny in-memory DataSource: transaction() rolls rows back when the callback throws. */
function build(over: { inquiry?: any; listing?: any | null } = {}) {
  const store = new Map<unknown, any[]>();
  const inquiry = {
    id: 'q1',
    public_ref: 'RQ-AJTZ9R',
    state: 'ASSIGNED',
    guest_user_id: GUEST,
    guest_name: 'Asha',
    guest_phone: '+919876543210',
    guest_email: 'asha@example.com',
    candidate_listing_id: 'cand1',
    target_listing_id: null,
    converted_booking_id: null,
    first_response_at: null,
    check_in: '2027-03-01',
    check_out: '2027-03-11',
    guests: 3,
    destination: 'Manali',
    ...over.inquiry,
  };
  const listing =
    over.listing === null
      ? null
      : { id: 'cand1', status: 'live', is_discovered: false, host_id: HOST, booking_eligible: true, claimed_at: new Date(), ...over.listing };
  store.set(InquiryEntity, [inquiry]);
  store.set(ListingEntity, listing ? [listing] : []);
  store.set(BookingEntity, [{ id: 'bk-existing', reference: 'RB-EXIST1' }]);
  store.set(InquiryEventEntity, []);
  store.set(InquiryMessageEntity, []);

  const repoFor = (entity: unknown) => {
    const rows = () => store.get(entity)!;
    return {
      findOne: jest.fn(async ({ where }: any) => rows().find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null),
      save: jest.fn(async (x: any) => {
        if (!rows().includes(x)) rows().push(x);
        return x;
      }),
      create: (x: any) => ({ ...x }),
    };
  };
  const dataSource = {
    transaction: jest.fn(async (cb: any) => {
      const snap = new Map([...store].map(([k, v]) => [k, v.map((r) => clone(r))]));
      const refs = new Map([...store].map(([k, v]) => [k, [...v]]));
      try {
        return await cb({ getRepository: repoFor });
      } catch (e) {
        // restore: same object identities with their old field values
        for (const [k, v] of refs) {
          store.set(k, v);
          v.forEach((obj, i) => {
            const old = snap.get(k)![i];
            if (old) Object.assign(obj, old);
          });
          store.set(k, v.slice(0, snap.get(k)!.length));
        }
        throw e;
      }
    }),
  };

  const created: any[] = [];
  const bookings = {
    create: jest.fn(async (_uid: string, _dto: any, key?: string) => {
      const prior = created.find((c) => c.key === key);
      if (prior) return { success: true, id: prior.id, status: 'requested', reference: prior.reference, replayed: true };
      const b = { key, id: `bk${created.length + 1}`, reference: `RB-NEW00${created.length + 1}` };
      created.push(b);
      return { success: true, id: b.id, status: 'requested', reference: b.reference };
    }),
  };
  const guestNotices = {
    requestSent: jest.fn().mockResolvedValue({ email: 'sent', whatsapp: 'sent' }),
    datesUnavailable: jest.fn().mockResolvedValue({ email: 'sent', whatsapp: 'skipped' }),
  };
  const svc = new InquiryOwnerRequestService(dataSource as any, bookings as any, guestNotices as any);
  const events = () => store.get(InquiryEventEntity)!;
  return { svc, inquiry, listing, bookings, guestNotices, dataSource, events, messages: () => store.get(InquiryMessageEntity)!, created };
}


async function reject(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected rejection');
}

describe('candidateReadiness (pure)', () => {
  const L = { id: 'l', status: 'live', is_discovered: false, host_id: HOST, booking_eligible: true };
  const I = { candidate_listing_id: 'l', guest_user_id: GUEST, check_in: '2027-03-01', check_out: '2027-03-05' };
  it('ok when everything is in place', () => expect(candidateReadiness(L, I)).toEqual({ ok: true }));
  it.each([
    ['no candidate', L, { ...I, candidate_listing_id: null }, 'No property attached to this request'],
    ['row missing', null, I, 'The property no longer exists'],
    ['discovered', { ...L, is_discovered: true }, I, 'The owner has not claimed this property yet'],
    ['host null', { ...L, host_id: null }, I, 'The owner has not claimed this property yet'],
    ['draft', { ...L, status: 'draft' }, I, 'Claimed, but the listing is still draft: the host must submit it and you must set it live'],
    ['not eligible', { ...L, booking_eligible: false }, I, 'Live, but booking is not enabled for this listing: enable booking eligibility in listing admin'],
    ['no guest', L, { ...I, guest_user_id: null }, 'The guest has no account: use "Dates not available" instead'],
    ['no dates', L, { ...I, check_out: null }, 'The request has no dates'],
    ['owner is guest', L, { ...I, guest_user_id: HOST }, 'The owner is the guest'],
  ])('%s -> refusal text', (_n, l, i, reason) => {
    expect(candidateReadiness(l as any, i as any)).toEqual({ ok: false, reason });
  });
  it('checks in the documented order (unclaimed beats not-live beats no-guest)', () => {
    expect(candidateReadiness({ ...L, is_discovered: true, status: 'discovered', booking_eligible: false }, { ...I, guest_user_id: null })).toMatchObject({ reason: 'The owner has not claimed this property yet' });
  });
});

describe('InquiryOwnerRequestService.sendToOwner: readiness refusals', () => {
  it.each([
    ['discovered', { listing: { is_discovered: true, host_id: null, status: 'discovered' } }],
    ['host null', { listing: { host_id: null } }],
    ['not live', { listing: { status: 'draft' } }],
    ['not booking eligible', { listing: { booking_eligible: false } }],
    ['no guest account', { inquiry: { guest_user_id: null } }],
    ['no dates', { inquiry: { check_in: null, check_out: null } }],
    ['owner is the guest', { inquiry: { guest_user_id: HOST } }],
    ['listing row gone', { listing: null }],
    ['no candidate', { inquiry: { candidate_listing_id: null } }],
  ])('%s: 409 NOT_READY, no booking, no state change, no note, no event, no notice', async (_n, over) => {
    const ctx = build(over as any);
    const err = await reject(ctx.svc.sendToOwner('q1', 'admin1', 'internal words'));
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: 'NOT_READY', message: expect.any(String) });
    expect(ctx.bookings.create).not.toHaveBeenCalled();
    expect(ctx.inquiry.state).toBe('ASSIGNED');
    expect(ctx.inquiry.converted_booking_id).toBeNull();
    expect(ctx.messages()).toHaveLength(0);
    expect(ctx.events()).toHaveLength(0);
    expect(ctx.guestNotices.requestSent).not.toHaveBeenCalled();
    expect(ctx.guestNotices.datesUnavailable).not.toHaveBeenCalled();
  });

  it('unknown inquiry is a refusal, not a crash', async () => {
    const ctx = build();
    const err = await reject(ctx.svc.sendToOwner('nope', 'admin1'));
    expect(err).toBeInstanceOf(ConflictException);
    expect(ctx.bookings.create).not.toHaveBeenCalled();
  });

  it.each(['DECLINED', 'EXPIRED', 'CLOSED'])('a %s inquiry is ALREADY_CLOSED and creates nothing', async (state) => {
    const ctx = build({ inquiry: { state } });
    const err = await reject(ctx.svc.sendToOwner('q1', 'admin1'));
    expect(err.getResponse()).toMatchObject({ code: 'ALREADY_CLOSED' });
    expect(ctx.bookings.create).not.toHaveBeenCalled();
  });
});

describe('InquiryOwnerRequestService.sendToOwner: success', () => {
  it('calls bookings.create once with the exact dto, key inquiry:<id> and source inquiry, then converts', async () => {
    const ctx = build();
    const res = await ctx.svc.sendToOwner('q1', 'admin1', '  owner joined  ');
    expect(ctx.bookings.create).toHaveBeenCalledTimes(1);
    expect(ctx.bookings.create).toHaveBeenCalledWith(
      GUEST,
      { listingId: 'cand1', moveIn: '2027-03-01', moveOut: '2027-03-11', days: 10, adults: 3, children: 0, infants: 0, pets: 0, paymentMethod: 'upi', role: 'guest' },
      'inquiry:q1',
      { source: 'inquiry' },
    );
    expect(res).toMatchObject({ id: 'q1', state: 'CONVERTED', changed: true, bookingId: 'bk1', bookingReference: 'RB-NEW001' });
    expect(ctx.inquiry).toMatchObject({ state: 'CONVERTED', converted_booking_id: 'bk1', target_listing_id: 'cand1' });
    expect(ctx.inquiry.first_response_at).toBeInstanceOf(Date);
    expect(ctx.messages()).toEqual([expect.objectContaining({ direction: 'internal', channel: 'internal', body: 'owner joined', actor_id: 'admin1' })]);
    expect(ctx.events()).toEqual([
      expect.objectContaining({ type: 'state_changed', from_state: 'ASSIGNED', to_state: 'CONVERTED', actor_id: 'admin1', meta: expect.objectContaining({ action: 'send_to_owner', bookingId: 'bk1', reference: 'RB-NEW001', note: true }) }),
    ]);
    expect(ctx.guestNotices.requestSent).toHaveBeenCalledTimes(1);
    expect(ctx.guestNotices.requestSent.mock.calls[0][1]).toEqual({ id: 'bk1', reference: 'RB-NEW001' });
    expect(ctx.guestNotices.datesUnavailable).not.toHaveBeenCalled();
  });

  it('works from NEW and HOST_CONTACTING, with no note saved when the note is empty', async () => {
    for (const state of ['NEW', 'HOST_CONTACTING']) {
      const ctx = build({ inquiry: { state } });
      await ctx.svc.sendToOwner('q1', 'admin1', '   ');
      expect(ctx.inquiry.state).toBe('CONVERTED');
      expect(ctx.messages()).toHaveLength(0);
    }
  });

  it('guests with a missing party size are sent as one adult; very long stays are clamped to 730 nights', async () => {
    const a = build({ inquiry: { guests: null } });
    await a.svc.sendToOwner('q1', 'admin1');
    expect(a.bookings.create.mock.calls[0][1].adults).toBe(1);
    const b = build({ inquiry: { check_in: '2027-01-01', check_out: '2030-01-01' } });
    await b.svc.sendToOwner('q1', 'admin1');
    expect(b.bookings.create.mock.calls[0][1].days).toBe(730);
  });

  it('accepts Date values for the stored dates', async () => {
    const ctx = build({ inquiry: { check_in: new Date('2027-03-01T00:00:00Z'), check_out: new Date('2027-03-04T00:00:00Z') } });
    await ctx.svc.sendToOwner('q1', 'admin1');
    expect(ctx.bookings.create.mock.calls[0][1]).toMatchObject({ moveIn: '2027-03-01', moveOut: '2027-03-04', days: 3 });
  });

  it('a notice that throws or fails never fails the action', async () => {
    const ctx = build();
    ctx.guestNotices.requestSent.mockRejectedValue(new Error('resend down'));
    const res = await ctx.svc.sendToOwner('q1', 'admin1');
    expect(res).toMatchObject({ state: 'CONVERTED', changed: true, bookingId: 'bk1' });
    expect(ctx.inquiry.state).toBe('CONVERTED');
  });

  it('sends no extra message to the owner (the owner message is the existing booking.requested)', () => {
    const ctx = build();
    expect(Object.keys(ctx.guestNotices)).toEqual(['requestSent', 'datesUnavailable']);
  });
});

describe('InquiryOwnerRequestService.sendToOwner: idempotency', () => {
  it('a second click after success is a no-op: one booking, no second notice, no new event', async () => {
    const ctx = build();
    await ctx.svc.sendToOwner('q1', 'admin1');
    const again = await ctx.svc.sendToOwner('q1', 'admin1');
    expect(again).toMatchObject({ state: 'CONVERTED', changed: false, bookingId: 'bk1' });
    expect(ctx.bookings.create).toHaveBeenCalledTimes(1);
    expect(ctx.created).toHaveLength(1);
    expect(ctx.guestNotices.requestSent).toHaveBeenCalledTimes(1);
    expect(ctx.events()).toHaveLength(1);
  });

  it('crash between create() and the state save heals on retry: same booking (replayed), converts, no duplicate notice', async () => {
    const ctx = build();
    // First attempt: the booking is created, then the inquiry transaction dies (state is rolled back).
    const realSave = ctx.dataSource.transaction.getMockImplementation()!;
    let boom = true;
    ctx.dataSource.transaction.mockImplementation(async (cb: any) =>
      realSave(async (m: any) => {
        const out = await cb({
          getRepository: (e: unknown) => {
            const r = m.getRepository(e);
            if (e === InquiryEntity && boom) {
              return { ...r, save: async () => { boom = false; throw new Error('connection lost'); } };
            }
            return r;
          },
        });
        return out;
      }),
    );
    await expect(ctx.svc.sendToOwner('q1', 'admin1')).rejects.toThrow('connection lost');
    expect(ctx.inquiry.state).toBe('ASSIGNED');
    expect(ctx.created).toHaveLength(1);
    expect(ctx.guestNotices.requestSent).not.toHaveBeenCalled();

    const res = await ctx.svc.sendToOwner('q1', 'admin1');
    expect(res).toMatchObject({ state: 'CONVERTED', changed: true, bookingId: 'bk1' });
    expect(ctx.created).toHaveLength(1); // the key replayed the same booking
    expect(ctx.inquiry.converted_booking_id).toBe('bk1');
    expect(ctx.guestNotices.requestSent).not.toHaveBeenCalled(); // replayed => the guest is not told twice
    expect(res.notices).toBeUndefined();
  });

  it('a replayed booking from the bookings service never produces a second guest notice', async () => {
    const ctx = build();
    ctx.bookings.create.mockResolvedValue({ success: true, id: 'bk9', status: 'requested', reference: 'RB-OLD999', replayed: true });
    const res = await ctx.svc.sendToOwner('q1', 'admin1');
    expect(res).toMatchObject({ state: 'CONVERTED', bookingId: 'bk9', bookingReference: 'RB-OLD999' });
    expect(ctx.guestNotices.requestSent).not.toHaveBeenCalled();
  });
});

describe('InquiryOwnerRequestService.sendToOwner: errors from the bookings service', () => {
  const dateErr = (code: string, E: any = ConflictException) => new E({ statusCode: 0, message: 'This property is not available for the selected dates.', code });

  it.each([
    ['DATES_BUSY', dateErr(BOOKING_ERROR_CODES.DATES_BUSY)],
    ['DATES_PAST', dateErr(BOOKING_ERROR_CODES.DATES_PAST, BadRequestException)],
  ])('%s: the request is closed as not available (DECLINED), the guest is told once, and no booking exists', async (_n, err) => {
    const ctx = build();
    ctx.bookings.create.mockRejectedValue(err);
    const res = await ctx.svc.sendToOwner('q1', 'admin1', 'dates gone');
    expect(res).toMatchObject({ id: 'q1', state: 'DECLINED', changed: true, autoUnavailable: true, reason: expect.any(String) });
    expect(ctx.inquiry.state).toBe('DECLINED');
    expect(ctx.inquiry.converted_booking_id).toBeNull();
    expect(ctx.events()[0]).toMatchObject({ to_state: 'DECLINED', meta: expect.objectContaining({ action: 'dates_unavailable', auto: true }) });
    expect(ctx.messages()).toHaveLength(1);
    expect(ctx.guestNotices.datesUnavailable).toHaveBeenCalledTimes(1);
    expect(ctx.guestNotices.datesUnavailable.mock.calls[0][1]).toBe('dates_error');
    expect(ctx.guestNotices.requestSent).not.toHaveBeenCalled();
    expect(res.notices).toEqual({ email: 'sent', whatsapp: 'skipped' });
  });

  it('OPEN_REQUEST: 409 GUEST_HAS_OPEN_REQUEST and nothing changes', async () => {
    const ctx = build();
    ctx.bookings.create.mockRejectedValue(dateErr(BOOKING_ERROR_CODES.OPEN_REQUEST));
    const e = await reject(ctx.svc.sendToOwner('q1', 'admin1', 'note'));
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getResponse()).toMatchObject({ code: 'GUEST_HAS_OPEN_REQUEST' });
    expect(ctx.inquiry.state).toBe('ASSIGNED');
    expect(ctx.messages()).toHaveLength(0);
    expect(ctx.events()).toHaveLength(0);
    expect(ctx.guestNotices.datesUnavailable).not.toHaveBeenCalled();
  });

  it.each([
    ['min stay 400', new BadRequestException('This property has a minimum stay of 7 nights.')],
    ['banned / unverified 403', new ForbiddenException('Please verify your contact details first.')],
    ['not found 404', new NotFoundException('Listing not found')],
    ['self overlap 409', new ConflictException({ statusCode: 409, message: 'You already have a pending request for this property for these dates.', code: BOOKING_ERROR_CODES.SELF_OVERLAP })],
  ])('%s: CANNOT_SEND with the original message and the inquiry unchanged', async (_n, err) => {
    const ctx = build();
    ctx.bookings.create.mockRejectedValue(err);
    const e = await reject(ctx.svc.sendToOwner('q1', 'admin1', 'x'));
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getResponse()).toMatchObject({ code: 'CANNOT_SEND', message: expect.stringMatching(/minimum stay|verify|not found|pending request/i) });
    expect(ctx.inquiry.state).toBe('ASSIGNED');
    expect(ctx.messages()).toHaveLength(0);
    expect(ctx.events()).toHaveLength(0);
    expect(ctx.guestNotices.datesUnavailable).not.toHaveBeenCalled();
    expect(ctx.guestNotices.requestSent).not.toHaveBeenCalled();
  });

  it('5xx and unknown errors are rethrown and leave the inquiry untouched', async () => {
    for (const err of [new InternalServerErrorException('Could not create the booking.'), new Error('socket hang up')]) {
      const ctx = build();
      ctx.bookings.create.mockRejectedValue(err);
      await expect(ctx.svc.sendToOwner('q1', 'admin1')).rejects.toBe(err);
      expect(ctx.inquiry.state).toBe('ASSIGNED');
      expect(ctx.events()).toHaveLength(0);
    }
  });

  it('a failing unavailable notice does not undo the DECLINED save', async () => {
    const ctx = build();
    ctx.bookings.create.mockRejectedValue(dateErr(BOOKING_ERROR_CODES.DATES_BUSY));
    ctx.guestNotices.datesUnavailable.mockRejectedValue(new Error('x'));
    const res = await ctx.svc.sendToOwner('q1', 'admin1');
    expect(res).toMatchObject({ state: 'DECLINED', autoUnavailable: true });
    expect(ctx.inquiry.state).toBe('DECLINED');
  });
});
