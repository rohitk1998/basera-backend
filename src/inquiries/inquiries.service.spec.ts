import * as fs from 'fs';
import * as path from 'path';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { InquiryEntity, InquiryEventEntity, InquiryMessageEntity } from '../entities';
import { setLockBackends } from '../common/leader-lock';
import { InquiriesService } from './inquiries.service';
import { InquiriesScheduler } from './inquiries.scheduler';
import { InquiryAdminNotices } from './inquiry-admin-notices.service';
import { InquiryGuestNotices } from './inquiry-guest-notices.service';
import { InquiryNoticeCore } from './inquiry-notice-core.service';
import {
  ACTIVE_STATES,
  INQUIRY_RESPONSE_WINDOW_MS,
  RESPONSE_WINDOW_CANDIDATE_MS,
  SWEEPABLE_STATES,
  TERMINAL_STATES,
  TRANSITIONS,
  canTransition,
  guestStatus,
  hashToken,
  tokenMatches,
} from './inquiry.util';
import { INQUIRY_STATES } from './inquiry.types';

let seq = 0;
function match(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
    if (v && typeof v === 'object' && '_type' in v) {
      const val = row[k];
      if (v._type === 'in') return v._value.includes(val);
      if (v._type === 'lessThan') return val < v._value;
      if (v._type === 'moreThan') return val > v._value;
      if (v._type === 'like') return String(val).startsWith(String(v._value).replace('%', ''));
      return false;
    }
    return row[k] === v;
  });
}
function fakeRepo(rows: any[] = []) {
  return {
    rows,
    create: (x: any) => ({ ...x }),
    save: async (x: any) => {
      if (!x.id) {
        x.id = `id${++seq}`;
        x.created_at ??= new Date();
        x.at ??= new Date();
        rows.push(x);
      }
      return x;
    },
    insert: async (x: any) => {
      const row = { id: `id${++seq}`, created_at: new Date(), at: new Date(), ...x };
      rows.push(row);
      return { identifiers: [{ id: row.id }] };
    },
    findOne: async ({ where }: any) => rows.find((r) => match(r, where)) ?? null,
    find: async ({ where }: any = {}) => rows.filter((r) => match(r, where)),
  };
}

/** inquiry_events fake that also answers the notice-dedupe count query. */
function fakeEventsRepo() {
  const repo: any = fakeRepo();
  repo.createQueryBuilder = () => {
    const p: Record<string, string> = {};
    const qb: any = {
      where: (_s: string, v: any) => (Object.assign(p, { id: v.id }), qb),
      andWhere: (_s: string, v?: any) => (v && Object.assign(p, v), qb),
      getCount: async () =>
        repo.rows.filter((r: any) => r.type === 'notice' && r.inquiry_id === p.id && r.meta.kind === p.kind && r.meta.to === p.to && r.meta.channel === p.channel).length,
    };
    return qb;
  };
  return repo;
}

const ymdIn = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const fmt = (ymd: string) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const CI = ymdIn(30);
const CO = ymdIn(33);
const GUEST_PHONE = '+919876543210';
const ADMIN_PHONE = '+919999900000';
const OWNER_PHONE_TEXT = '+91 98160 12345';

interface BuildOpts {
  users?: any[];
  env?: Record<string, string | undefined>;
  consent?: any;
}

function build(opts: BuildOpts = {}) {
  const inquiries: any = fakeRepo();
  // The action transaction re-reads the row with a locking query builder.
  inquiries.createQueryBuilder = () => {
    let id: string;
    const qb: any = { setLock: () => qb, where: (_s: string, v: any) => ((id = v.id), qb), getOne: async () => inquiries.rows.find((r: any) => r.id === id) ?? null };
    return qb;
  };
  // Guarded sweep update: UPDATE ... WHERE id AND state IN (...) AND response_due_at < now.
  inquiries.createQueryBuilder = ((orig: any) => () => {
    const qb: any = orig();
    let patch: any;
    let p: any;
    qb.update = () => qb;
    qb.set = (v: any) => ((patch = v), qb);
    const w = qb.where;
    qb.where = (s: string, v: any) => ((p = v), w(s, v));
    qb.execute = async () => {
      const r = inquiries.rows.find((x: any) => x.id === p.id && p.st.includes(x.state) && x.response_due_at < p.now);
      if (r) Object.assign(r, patch);
      return { affected: r ? 1 : 0 };
    };
    return qb;
  })(inquiries.createQueryBuilder);
  const messages = fakeRepo();
  const events = fakeEventsRepo();
  const listings = fakeRepo([
    { id: 'live1', status: 'live', is_discovered: false, host_id: 'h1', draft_data: { property_details: { title: 'Pine Cabin' } } },
    { id: 'disc1', status: 'discovered', is_discovered: true, host_id: null, draft_data: { property: { title: 'SECRET Hotel' } } },
    { id: 'draft1', status: 'draft', is_discovered: false, host_id: 'h2', draft_data: {} },
    {
      id: 'cand1',
      status: 'discovered',
      is_discovered: true,
      host_id: null,
      booking_eligible: false,
      external_place_id: 'ChIJabcdefghij1',
      discovery_destination: 'Manali',
      disc_district: 'Kullu',
      disc_tehsil: 'Manali',
      draft_data: { property_details: { title: 'Hotel Sunrise Manali' } },
    },
  ]);
  const users = fakeRepo(opts.users ?? [{ id: 'admin1', role: 'admin', full_name: 'Priya Sharma' }, { id: 'host1', role: 'host' }]);
  const bookings = fakeRepo([{ id: 'bk1', listing_id: 'live1', guest_id: 'g1', status: 'requested', reference: 'RB-AAAAAA' }]);

  const env: Record<string, string | undefined> = { ADMIN_WHATSAPP_NUMBER: ADMIN_PHONE, ...opts.env };
  const config = { get: (k: string) => env[k] };
  const notifications = {
    dispatch: jest.fn().mockResolvedValue([{ channel: 'in_app', status: 'sent' }, { channel: 'email', status: 'sent' }]),
    sendEmailToAddress: jest.fn().mockResolvedValue('sent'),
    notify: jest.fn(),
  };
  const whatsapp = { sendTemplate: jest.fn().mockResolvedValue({ status: 'queued', waMessageId: 'w1', dryRun: false }) };
  const consent = { get: jest.fn().mockResolvedValue(opts.consent ?? null), set: jest.fn().mockResolvedValue(undefined) };

  const core = new InquiryNoticeCore(events as any, listings as any, whatsapp as any, consent as any, config as any);
  const guestNotices = new InquiryGuestNotices(core, notifications as any);
  const adminNotices = new InquiryAdminNotices(core, notifications as any, users as any);
  const ownerRequest = { sendToOwner: jest.fn().mockResolvedValue({ id: 'x', state: 'CONVERTED', changed: true }) };

  const repoByEntity = new Map<unknown, any>([
    [InquiryEntity, inquiries],
    [InquiryMessageEntity, messages],
    [InquiryEventEntity, events],
  ]);
  const dataSource = { transaction: jest.fn(async (cb: any) => cb({ getRepository: (e: unknown) => repoByEntity.get(e) })) };

  const svc = new InquiriesService(
    inquiries as any,
    messages as any,
    events as any,
    listings as any,
    users as any,
    bookings as any,
    dataSource as any,
    core,
    guestNotices,
    adminNotices,
    ownerRequest as any,
  );
  return { svc, inquiries, messages, events, listings, users, bookings, notifications, whatsapp, consent, core, guestNotices, adminNotices, ownerRequest, dataSource };
}

const base = { guestName: 'Asha', guestPhone: GUEST_PHONE, consentContact: true as const, destination: 'Manali' };
const tick = () => new Promise((r) => setImmediate(r));
const waTemplates = (b: ReturnType<typeof build>) => b.whatsapp.sendTemplate.mock.calls.map((c: any[]) => c[0].template);
const dispatched = (b: ReturnType<typeof build>) => b.notifications.dispatch.mock.calls.map((c: any[]) => c[0]);
const noticeEvents = (b: ReturnType<typeof build>) => b.events.rows.filter((e: any) => e.type === 'notice');

/** An inquiry about the unclaimed property cand1, made by account u1 (has an email), assigned to the primary admin. */
async function candidateRequest(extra: BuildOpts = {}) {
  const b = build({
    users: [
      { id: 'a-main', role: 'admin', email: 'admin@rhenbasera.com', full_name: 'Priya Sharma' },
      { id: 'u1', role: 'guest', full_name: 'Asha Verma', phone: '98765 43210', email: 'asha@example.com' },
    ],
    ...extra,
  });
  const r = await b.svc.createForUser('u1', { candidateRef: 'cand1', checkIn: CI, checkOut: CO, guests: 2 } as any, { tokenPhone: GUEST_PHONE });
  const row = b.inquiries.rows[0];
  return { ...b, r, row, id: row.id as string };
}

describe('InquiriesService', () => {
  it('creates a request-only inquiry, returns a token and stores only its hash', async () => {
    const { svc, inquiries, bookings, notifications } = build();
    const r = await svc.create({ ...base } as any);
    expect(r.publicRef).toMatch(/^RQ-[A-Z0-9]{6}$/);
    expect(r.accessToken).toBeTruthy();
    const row = inquiries.rows[0];
    expect(row.access_token_hash).toBe(hashToken(r.accessToken!));
    expect(JSON.stringify(row)).not.toContain(r.accessToken);
    expect(row.state).toBe('NEW');
    expect(row.consent_text_version).toBeTruthy();
    expect(row.response_due_at.getTime() - row.consent_at.getTime()).toBe(INQUIRY_RESPONSE_WINDOW_MS);
    expect(bookings.rows).toHaveLength(1); // untouched
    expect(notifications.dispatch).toHaveBeenCalledWith('inquiry.new', 'admin1', expect.anything(), { dedupeKey: `inquiry:${row.id}:admin` });
  });

  it('requires consent', async () => {
    const { svc, inquiries } = build();
    await expect(svc.create({ ...base, consentContact: false } as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(inquiries.rows).toHaveLength(0);
  });

  it('requires a target or destination, and sane dates', async () => {
    const { svc } = build();
    await expect(svc.create({ ...base, destination: undefined } as any)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create({ ...base, checkIn: '2020-01-01', checkOut: '2020-01-03' } as any)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create({ ...base, budgetMin: 5000, budgetMax: 100 } as any)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('dedupes same contact+target+dates within 24h (idempotent, no second token, no second notice)', async () => {
    const { svc, inquiries, notifications, whatsapp } = build();
    const a = await svc.create({ ...base } as any);
    const sent = notifications.dispatch.mock.calls.length + whatsapp.sendTemplate.mock.calls.length;
    const b = await svc.create({ ...base } as any);
    expect(b.publicRef).toBe(a.publicRef);
    expect(b.duplicate).toBe(true);
    expect(b.accessToken).toBeNull();
    expect(inquiries.rows).toHaveLength(1);
    expect(notifications.dispatch.mock.calls.length + whatsapp.sendTemplate.mock.calls.length).toBe(sent);
    const later = await svc.create({ ...base } as any, new Date(Date.now() + 25 * 3600 * 1000));
    expect(later.duplicate).toBe(false);
    expect(inquiries.rows).toHaveLength(2);
  });

  it('rejects discovered, draft and unknown targets with the same error', async () => {
    const { svc } = build();
    const errs = await Promise.all(['disc1', 'draft1', 'nope'].map((id) => svc.create({ ...base, targetListingId: id } as any).catch((e) => e.message)));
    expect(new Set(errs).size).toBe(1);
    expect(errs[0]).toMatch(/not available/);
  });

  it('keeps the candidate id server-side and the public view never exposes owner contact, address, maps or Google text', async () => {
    const b = build();
    (b.svc as any).places = { getContact: jest.fn(async () => ({ name: 'Ara Homestay', address: 'Old Manali', phone: OWNER_PHONE_TEXT, mapsUrl: 'https://maps.google.com/?cid=1' })) };
    const r = await b.svc.create({ ...base, candidateRef: 'cand1' } as any);
    expect(b.inquiries.rows[0].candidate_listing_id).toBe('cand1');
    const pub = await b.svc.getPublic(r.publicRef, r.accessToken!);
    expect(JSON.stringify(pub)).not.toMatch(/candidate|98160|Ara Homestay|Old Manali|maps\.google|mapsUrl|address|phone/i);
    expect((b.svc as any).places.getContact).not.toHaveBeenCalled();
    const ignored = await b.svc.create({ ...base, destination: 'Kasol', candidateRef: 'live1' } as any);
    expect(b.inquiries.rows.find((x: any) => x.public_ref === ignored.publicRef).candidate_listing_id).toBeNull();
  });

  it('stores requirements as an internal note, never as a guest-visible message', async () => {
    const { svc, messages } = build();
    await svc.create({ ...base, requirements: 'quiet room' } as any);
    expect(messages.rows).toHaveLength(1);
    expect(messages.rows[0]).toMatchObject({ direction: 'internal', channel: 'internal', body: 'Requirements: quiet room' });
  });

  it('assign requires an admin assignee and moves NEW to ASSIGNED', async () => {
    const { svc, inquiries } = build();
    await svc.create({ ...base } as any);
    const id = inquiries.rows[0].id;
    await expect(svc.assign(id, 'host1', 'admin1')).rejects.toBeInstanceOf(BadRequestException);
    await svc.assign(id, 'admin1', 'admin1');
    expect(inquiries.rows[0].state).toBe('ASSIGNED');
    expect(inquiries.rows[0].assigned_to).toBe('admin1');
  });
});

describe('simplified state machine', () => {
  it('has exactly the documented transitions (legacy states only lead out)', () => {
    expect(TRANSITIONS).toEqual({
      NEW: ['ASSIGNED', 'HOST_CONTACTING', 'CONVERTED', 'DECLINED', 'EXPIRED'],
      ASSIGNED: ['HOST_CONTACTING', 'CONVERTED', 'DECLINED', 'EXPIRED'],
      HOST_CONTACTING: ['CONVERTED', 'DECLINED', 'EXPIRED'],
      HOST_RESPONDED: ['DECLINED', 'EXPIRED'],
      OFFER_PENDING: ['DECLINED', 'EXPIRED'],
      OFFER_SENT: ['DECLINED', 'EXPIRED'],
      CONVERTED: [],
      DECLINED: [],
      EXPIRED: [],
      CLOSED: [],
    });
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...INQUIRY_STATES].sort());
    expect(Object.values(TRANSITIONS).flat().includes('NEW' as any)).toBe(false);
  });

  it('canTransition follows the table; terminals never move', () => {
    expect(canTransition('NEW', 'CONVERTED')).toBe(true);
    expect(canTransition('HOST_CONTACTING', 'ASSIGNED')).toBe(false);
    expect(canTransition('HOST_CONTACTING', 'HOST_RESPONDED')).toBe(false);
    expect(canTransition('NEW', 'OFFER_SENT')).toBe(false);
    expect(canTransition('NEW', 'CLOSED')).toBe(false);
    expect(canTransition('HOST_RESPONDED', 'CONVERTED')).toBe(false);
    for (const t of ['CONVERTED', 'DECLINED', 'EXPIRED', 'CLOSED'] as const) {
      for (const to of INQUIRY_STATES) expect(canTransition(t, to)).toBe(false);
    }
  });

  it('active / sweepable / terminal sets', () => {
    expect([...ACTIVE_STATES]).toEqual(['NEW', 'ASSIGNED', 'HOST_CONTACTING']);
    expect([...SWEEPABLE_STATES]).toEqual(expect.arrayContaining(['NEW', 'ASSIGNED', 'HOST_CONTACTING', 'HOST_RESPONDED', 'OFFER_PENDING', 'OFFER_SENT']));
    expect([...TERMINAL_STATES].sort()).toEqual(['CLOSED', 'CONVERTED', 'DECLINED', 'EXPIRED']);
  });

  it('maps internal states to guest-safe statuses', () => {
    expect(guestStatus('NEW', true)).toBe('received');
    expect(guestStatus('ASSIGNED', true)).toBe('received');
    for (const s of ['HOST_CONTACTING', 'HOST_RESPONDED', 'OFFER_PENDING', 'OFFER_SENT'] as const) expect(guestStatus(s, true)).toBe('received');
    expect(guestStatus('CONVERTED', true)).toBe('sent_to_owner');
    expect(guestStatus('DECLINED', true)).toBe('unavailable');
    expect(guestStatus('EXPIRED', true)).toBe('unavailable');
    expect(guestStatus('EXPIRED', false)).toBe('expired');
    expect(guestStatus('CLOSED', false)).toBe('closed');
  });

  it('the removed admin methods are gone', () => {
    for (const m of ['changeState', 'addMessage', 'suggestAlternatives', 'setOffer', 'close', 'convert', 'notifyOps']) {
      expect((InquiriesService.prototype as any)[m]).toBeUndefined();
    }
  });
});

describe('only sendToOwner reaches the bookings service', () => {
  it('the service has no payment or booking-creation methods besides sendToOwner, and never imports BookingsService', () => {
    const names = Object.getOwnPropertyNames(InquiriesService.prototype).filter((n) => /pay|createBooking|book/i.test(n));
    expect(names).toEqual([]);
    expect(typeof InquiriesService.prototype.sendToOwner).toBe('function');
    const src = fs.readFileSync(path.join(__dirname, 'inquiries.service.ts'), 'utf8');
    expect(src).not.toMatch(/BookingsService/);
    expect(src).not.toMatch(/this\.bookings\.(create|save|insert|update)\b/);
  });

  it('sendToOwner delegates; contacting and notAvailable never touch it', async () => {
    const b = build();
    await b.svc.create({ ...base } as any);
    const id = b.inquiries.rows[0].id;
    await b.svc.contacting(id, 'admin1');
    await b.svc.notAvailable(id, 'admin1');
    expect(b.ownerRequest.sendToOwner).not.toHaveBeenCalled();
    await b.svc.sendToOwner(id, 'admin1', 'n');
    expect(b.ownerRequest.sendToOwner).toHaveBeenCalledWith(id, 'admin1', 'n');
    expect(b.bookings.rows).toHaveLength(1);
  });
});

describe('contacting', () => {
  it('moves to HOST_CONTACTING, stores the note as internal, stamps first_response_at and records one event', async () => {
    const b = build();
    await b.svc.create({ ...base } as any);
    const id = b.inquiries.rows[0].id;
    const res = await b.svc.contacting(id, 'admin1', '  called, owner will call back  ');
    expect(res).toEqual({ id, state: 'HOST_CONTACTING', changed: true });
    expect(b.inquiries.rows[0].state).toBe('HOST_CONTACTING');
    expect(b.inquiries.rows[0].first_response_at).toBeInstanceOf(Date);
    expect(b.messages.rows.filter((m: any) => m.direction === 'internal' && m.body === 'called, owner will call back')).toEqual([
      expect.objectContaining({ inquiry_id: id, channel: 'internal', actor_id: 'admin1' }),
    ]);
    const ev = b.events.rows.filter((e: any) => e.type === 'state_changed' && e.meta.action === 'contacting');
    expect(ev).toEqual([expect.objectContaining({ from_state: 'NEW', to_state: 'HOST_CONTACTING', actor_id: 'admin1', meta: expect.objectContaining({ note: true }) })]);
    expect(JSON.stringify(ev)).not.toContain('called, owner');
  });

  it('sends no notice to the guest', async () => {
    const b = await candidateRequest();
    const before = { d: b.notifications.dispatch.mock.calls.length, w: b.whatsapp.sendTemplate.mock.calls.length };
    await b.svc.contacting(b.id, 'a-main');
    expect(b.notifications.dispatch.mock.calls.length).toBe(before.d);
    expect(b.whatsapp.sendTemplate.mock.calls.length).toBe(before.w);
    expect(b.inquiries.rows[0].state).toBe('HOST_CONTACTING');
  });

  it('works from ASSIGNED and without a note (no message row)', async () => {
    const b = await candidateRequest();
    expect(b.row.state).toBe('ASSIGNED');
    const n = b.messages.rows.length;
    await b.svc.contacting(b.id, 'a-main', '   ');
    expect(b.messages.rows.length).toBe(n);
  });

  it('a repeat is a 200 no-op that writes nothing, not even the new note', async () => {
    const b = build();
    await b.svc.create({ ...base } as any);
    const id = b.inquiries.rows[0].id;
    await b.svc.contacting(id, 'admin1', 'first');
    const counts = [b.messages.rows.length, b.events.rows.length];
    const again = await b.svc.contacting(id, 'admin1', 'second');
    expect(again).toEqual({ id, state: 'HOST_CONTACTING', changed: false });
    expect([b.messages.rows.length, b.events.rows.length]).toEqual(counts);
  });

  it.each(['CONVERTED', 'DECLINED', 'EXPIRED', 'CLOSED'])('a %s request is 409 ALREADY_CLOSED and nothing is written', async (state) => {
    const b = build();
    await b.svc.create({ ...base } as any);
    const id = b.inquiries.rows[0].id;
    b.inquiries.rows[0].state = state;
    const counts = [b.messages.rows.length, b.events.rows.length];
    const err: any = await b.svc.contacting(id, 'admin1', 'note').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: 'ALREADY_CLOSED' });
    expect([b.messages.rows.length, b.events.rows.length]).toEqual(counts);
    expect(b.inquiries.rows[0].state).toBe(state);
  });

  it('unknown inquiry is a 404', async () => {
    const b = build();
    await expect(b.svc.contacting('nope', 'admin1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('notAvailable (dates not available: tell the guest)', () => {
  it('closes as DECLINED and tells the guest by email and WhatsApp with a verified-stays link in the town', async () => {
    const b = await candidateRequest();
    const res = await b.svc.notAvailable(b.id, 'a-main', 'owner booked elsewhere');
    expect(res).toMatchObject({ id: b.id, state: 'DECLINED', changed: true, notices: { email: 'sent', whatsapp: 'sent' } });
    expect(b.inquiries.rows[0].state).toBe('DECLINED');
    expect(b.inquiries.rows[0].first_response_at).toBeInstanceOf(Date);
    const call = b.notifications.dispatch.mock.calls.find((c: any[]) => c[0] === 'inquiry.dates_unavailable')!;
    expect(call[1]).toBe('u1');
    expect(call[2]).toMatchObject({ propertyName: 'Hotel Sunrise Manali', town: 'Kullu', link: '/stays?q=Kullu', checkIn: fmt(CI) });
    const wa = b.whatsapp.sendTemplate.mock.calls.map((c: any[]) => c[0]).find((c: any) => c.template === 'stay_dates_unavailable');
    expect(wa).toMatchObject({ to: GUEST_PHONE, relatedType: 'inquiry', relatedId: b.id });
    expect(wa.params.stays_url).toBe('https://www.rhenbasera.online/stays?q=Kullu');
    expect(b.events.rows.find((e: any) => e.type === 'state_changed' && e.to_state === 'DECLINED')).toMatchObject({ actor_id: 'a-main', meta: expect.objectContaining({ action: 'dates_unavailable', note: true }) });
    expect(b.messages.rows.some((m: any) => m.body === 'owner booked elsewhere' && m.direction === 'internal')).toBe(true);
  });

  it('the internal note and the owner phone never reach the guest', async () => {
    const b = await candidateRequest();
    (b.svc as any).places = { getContact: jest.fn(async () => ({ name: 'x', phone: OWNER_PHONE_TEXT, address: 'Old Manali', mapsUrl: 'https://maps.google.com/?cid=1' })) };
    await b.svc.notAvailable(b.id, 'a-main', 'SECRET-INTERNAL');
    const all = JSON.stringify([b.notifications.dispatch.mock.calls, b.whatsapp.sendTemplate.mock.calls]);
    expect(all).not.toMatch(/SECRET-INTERNAL|98160|Old Manali|maps\.google|escrow/i);
  });

  it('a second click sends nothing and reports changed:false', async () => {
    const b = await candidateRequest();
    await b.svc.notAvailable(b.id, 'a-main');
    const d = b.notifications.dispatch.mock.calls.length;
    const w = b.whatsapp.sendTemplate.mock.calls.length;
    const events = b.events.rows.length;
    const again = await b.svc.notAvailable(b.id, 'a-main', 'again');
    expect(again).toMatchObject({ state: 'DECLINED', changed: false });
    expect(b.notifications.dispatch.mock.calls.length).toBe(d);
    expect(b.whatsapp.sendTemplate.mock.calls.length).toBe(w);
    expect(b.events.rows.length).toBe(events);
    expect(noticeEvents(b).filter((e: any) => e.meta.kind === 'unavailable')).toHaveLength(2); // email + whatsapp, once each
  });

  it('an already expired request is a no-op and is not messaged by the click', async () => {
    const b = await candidateRequest();
    b.inquiries.rows[0].state = 'EXPIRED';
    const d = b.notifications.dispatch.mock.calls.length;
    const res = await b.svc.notAvailable(b.id, 'a-main');
    expect(res).toMatchObject({ state: 'EXPIRED', changed: false });
    expect(b.notifications.dispatch.mock.calls.length).toBe(d);
  });

  it.each(['CONVERTED', 'CLOSED'])('a %s request is 409 ALREADY_CLOSED, state unchanged, no notice', async (state) => {
    const b = await candidateRequest();
    b.inquiries.rows[0].state = state;
    const d = b.notifications.dispatch.mock.calls.length;
    const err: any = await b.svc.notAvailable(b.id, 'a-main', 'x').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: 'ALREADY_CLOSED' });
    expect(b.inquiries.rows[0].state).toBe(state);
    expect(b.notifications.dispatch.mock.calls.length).toBe(d);
  });

  it('legacy in-flight states can still be closed this way', async () => {
    const b = await candidateRequest();
    b.inquiries.rows[0].state = 'HOST_RESPONDED';
    const res = await b.svc.notAvailable(b.id, 'a-main');
    expect(res).toMatchObject({ state: 'DECLINED', changed: true });
  });

  it('no WhatsApp consent (gate blocks): email still goes, WhatsApp is skipped with the reason', async () => {
    const b = await candidateRequest();
    b.whatsapp.sendTemplate.mockResolvedValue({ status: 'blocked', reason: 'blocked: no consent' });
    const res = await b.svc.notAvailable(b.id, 'a-main');
    expect(res.notices).toMatchObject({ email: 'sent', whatsapp: 'skipped', reasons: { whatsapp: 'blocked: no consent' } });
    expect(res.state).toBe('DECLINED');
  });

  it('failing or throwing channels never fail the action', async () => {
    const b = await candidateRequest();
    b.notifications.dispatch.mockRejectedValue(new Error('resend down'));
    b.whatsapp.sendTemplate.mockRejectedValue(new Error('meta down'));
    const res = await b.svc.notAvailable(b.id, 'a-main');
    expect(res).toMatchObject({ state: 'DECLINED', changed: true, notices: { email: 'failed', whatsapp: 'failed' } });
    expect(b.inquiries.rows[0].state).toBe('DECLINED');
  });

  it('even a notice service that throws outright does not fail the action', async () => {
    const b = await candidateRequest();
    jest.spyOn(b.guestNotices, 'datesUnavailable').mockRejectedValue(new Error('boom'));
    await expect(b.svc.notAvailable(b.id, 'a-main')).resolves.toMatchObject({ state: 'DECLINED', changed: true, notices: { email: 'failed', whatsapp: 'failed' } });
  });

  it('an anonymous-form guest is messaged at the stored email and phone', async () => {
    const b = build();
    await b.svc.create({ ...base, guestEmail: 'Anon@Example.com', candidateRef: 'cand1', checkIn: CI, checkOut: CO } as any);
    const id = b.inquiries.rows[0].id;
    b.notifications.dispatch.mockClear();
    b.notifications.sendEmailToAddress.mockClear();
    b.whatsapp.sendTemplate.mockClear();
    const res = await b.svc.notAvailable(id, 'admin1');
    expect(res.notices).toMatchObject({ email: 'sent', whatsapp: 'sent' });
    expect(b.notifications.dispatch).not.toHaveBeenCalled();
    expect(b.notifications.sendEmailToAddress).toHaveBeenCalledWith('anon@example.com', 'inquiry.dates_unavailable', expect.objectContaining({ link: '/stays?q=Kullu' }));
    expect(b.whatsapp.sendTemplate.mock.calls[0][0].to).toBe(GUEST_PHONE);
  });
});

describe('submitting a request notifies both parties', () => {
  it('guest gets email + WhatsApp, the assigned admin gets email + WhatsApp, none with owner phone or "escrow"', async () => {
    const b = await candidateRequest();
    (b.svc as any).places = { getContact: jest.fn(async () => ({ phone: OWNER_PHONE_TEXT })) };
    const guestCall = b.notifications.dispatch.mock.calls.find((c: any[]) => c[0] === 'inquiry.guest_received')!;
    expect(guestCall[1]).toBe('u1');
    expect(guestCall[2]).toMatchObject({ guestName: 'Asha Verma', propertyName: 'Hotel Sunrise Manali', town: 'Kullu', checkIn: fmt(CI), checkOut: fmt(CO), guests: 2, ref: b.row.public_ref });
    expect(guestCall[3]).toEqual({ dedupeKey: `inquiry:${b.id}:received` });
    const adminCall = b.notifications.dispatch.mock.calls.find((c: any[]) => c[0] === 'inquiry.new')!;
    expect(adminCall[1]).toBe('a-main');
    expect(adminCall[2]).toMatchObject({ propertyName: 'Hotel Sunrise Manali', ref: b.row.public_ref, link: '/admin' });
    const calls = b.whatsapp.sendTemplate.mock.calls.map((c: any[]) => c[0]);
    const g = calls.find((c: any) => c.template === 'stay_request_received');
    const a = calls.find((c: any) => c.template === 'stay_request_admin_alert');
    expect(g).toMatchObject({ to: GUEST_PHONE, params: { guest_name: 'Asha Verma', property_name: 'Hotel Sunrise Manali', check_in_date: fmt(CI), check_out_date: fmt(CO) } });
    expect(a).toMatchObject({ to: ADMIN_PHONE });
    expect(a.params).toMatchObject({ request_ref: b.row.public_ref, guest_name: 'Asha Verma', admin_name: 'Priya' });
    expect(JSON.stringify([b.notifications.dispatch.mock.calls, calls])).not.toMatch(/98160|escrow/i);
    expect((b.svc as any).places.getContact).not.toHaveBeenCalled();
    // the request is assigned to the primary admin and the only admin messaged is that admin
    expect(b.row).toMatchObject({ assigned_to: 'a-main', state: 'ASSIGNED' });
    expect(b.notifications.dispatch.mock.calls.filter((c: any[]) => c[0] === 'inquiry.new').map((c: any[]) => c[1])).toEqual(['a-main']);
  });

  it('each notice is recorded once (no phone/email in the log) so retries cannot duplicate it', async () => {
    const b = await candidateRequest();
    const kinds = noticeEvents(b).map((e: any) => `${e.meta.kind}/${e.meta.to}/${e.meta.channel}/${e.meta.status}`).sort();
    expect(kinds).toEqual(['admin_new/admin/email/sent', 'admin_new/admin/whatsapp/sent', 'received/guest/email/sent', 'received/guest/whatsapp/sent']);
    expect(JSON.stringify(noticeEvents(b))).not.toMatch(/9876543210|asha@example|9999900000/);
  });

  it('without ADMIN_WHATSAPP_NUMBER the admin WhatsApp is skipped (logged), everything else still goes', async () => {
    const b = await candidateRequest({ env: { ADMIN_WHATSAPP_NUMBER: undefined } });
    expect(waTemplates(b)).toEqual(['stay_request_received']);
    expect(noticeEvents(b).find((e: any) => e.meta.to === 'admin' && e.meta.channel === 'whatsapp').meta).toMatchObject({ status: 'skipped', reason: 'not_configured' });
    expect(dispatched(b)).toEqual(expect.arrayContaining(['inquiry.guest_received', 'inquiry.new']));
  });

  it('WhatsApp blocked (not configured / no consent) is skipped and email still goes', async () => {
    const b = build({ users: [{ id: 'u1', role: 'guest', full_name: 'Asha', phone: GUEST_PHONE, email: 'asha@example.com' }] });
    b.whatsapp.sendTemplate.mockResolvedValue({ status: 'blocked', reason: 'blocked: not configured' });
    const r = await b.svc.createForUser('u1', { candidateRef: 'cand1' } as any);
    expect(r.publicRef).toMatch(/^RQ-/);
    expect(dispatched(b)).toContain('inquiry.guest_received');
    expect(noticeEvents(b).filter((e: any) => e.meta.channel === 'whatsapp').every((e: any) => e.meta.status === 'skipped')).toBe(true);
  });

  it('failing, throwing or blocked channels never fail or roll back the request', async () => {
    const b = build({ users: [{ id: 'a-main', role: 'admin', email: 'admin@rhenbasera.com' }, { id: 'u1', role: 'guest', full_name: 'Asha', phone: GUEST_PHONE, email: 'a@b.co' }] });
    b.notifications.dispatch.mockRejectedValue(new Error('resend 500'));
    b.whatsapp.sendTemplate.mockRejectedValue(new Error('meta 500'));
    b.consent.get.mockRejectedValue(new Error('db'));
    const r = await b.svc.createForUser('u1', { candidateRef: 'cand1' } as any);
    expect(r.publicRef).toMatch(/^RQ-/);
    expect(r.accessToken).toBeTruthy();
    expect(b.inquiries.rows).toHaveLength(1);
    expect(b.inquiries.rows[0].state).toBe('ASSIGNED');
  });

  it('even notice services that throw outright do not fail the request', async () => {
    const b = build();
    jest.spyOn(b.guestNotices, 'received').mockRejectedValue(new Error('x'));
    jest.spyOn(b.adminNotices, 'newRequest').mockRejectedValue(new Error('y'));
    jest.spyOn(b.core, 'grantGuestConsentOnCreate').mockRejectedValue(new Error('z'));
    await expect(b.svc.create({ ...base } as any)).resolves.toMatchObject({ duplicate: false });
    expect(b.inquiries.rows).toHaveLength(1);
  });

  it('the anonymous form guest is messaged at the stored email and phone (no account needed)', async () => {
    const b = build();
    await b.svc.create({ ...base, guestEmail: 'anon@example.com' } as any);
    expect(b.notifications.sendEmailToAddress).toHaveBeenCalledWith('anon@example.com', 'inquiry.guest_received', expect.objectContaining({ guestName: 'Asha' }));
    expect(b.whatsapp.sendTemplate.mock.calls.find((c: any[]) => c[0].template === 'stay_request_received')![0].to).toBe(GUEST_PHONE);
    expect(b.notifications.dispatch.mock.calls.some((c: any[]) => c[0] === 'inquiry.guest_received')).toBe(false);
  });

  describe('WhatsApp opt-in', () => {
    it('grants consent for a number that has none, with a request-scoped source', async () => {
      const b = await candidateRequest();
      expect(b.consent.set).toHaveBeenCalledWith('phone', GUEST_PHONE, 'whatsapp', 'granted', `inquiry:${b.id}:request`);
    });
    it('never re-grants a revoked (STOP) number, and the gate then skips WhatsApp', async () => {
      const b = await candidateRequest({ consent: { consent_status: 'revoked' } });
      expect(b.consent.set).not.toHaveBeenCalled();
    });
    it('does not rewrite an existing grant', async () => {
      const b = await candidateRequest({ consent: { consent_status: 'granted' } });
      expect(b.consent.set).not.toHaveBeenCalled();
    });
    it('swallows consent errors', async () => {
      const b = build({ users: [{ id: 'u1', role: 'guest', full_name: 'Asha', phone: GUEST_PHONE, email: null }] });
      b.consent.get.mockRejectedValue(new Error('db'));
      b.consent.set.mockRejectedValue(new Error('db'));
      await expect(b.svc.createForUser('u1', { candidateRef: 'cand1' } as any)).resolves.toMatchObject({ duplicate: false });
    });
  });
});

describe('getPublic: new shape and no leaks', () => {
  it('needs the right token and leaks no PII, internal notes or internal state names', async () => {
    const b = build();
    const r = await b.svc.create({ ...base, guestEmail: 'a@b.co', requirements: 'quiet' } as any);
    const inq = b.inquiries.rows[0];
    await b.svc.contacting(inq.id, 'admin1', 'INTERNAL-NOTE call host');
    await expect(b.svc.getPublic(r.publicRef, 'wrong-token-wrong-token-xx')).rejects.toBeInstanceOf(NotFoundException);
    await expect(b.svc.getPublic(r.publicRef, undefined)).rejects.toBeInstanceOf(NotFoundException);
    await expect(b.svc.getPublic('RQ-ZZZZZZ', r.accessToken!)).rejects.toBeInstanceOf(NotFoundException);
    const pub: any = await b.svc.getPublic(r.publicRef, r.accessToken!);
    expect(JSON.stringify(pub)).not.toMatch(/INTERNAL-NOTE|9876543210|a@b\.co|admin1|access_token|assigned|HOST_CONTACTING|ASSIGNED|escrow/i);
    expect(pub.status).toBe('received');
    expect(pub).not.toHaveProperty('alternatives');
    expect(pub).not.toHaveProperty('messages');
    expect(pub).not.toHaveProperty('budgetMin');
    expect(pub).toHaveProperty('property');
    expect(pub).toHaveProperty('bookingId');
    expect(pub).toHaveProperty('staysPath');
  });

  it('shows the property (stored columns only) and a stays link only once it is unavailable', async () => {
    const b = await candidateRequest();
    const tok = b.r.accessToken!;
    const received: any = await b.svc.getPublic(b.r.publicRef, tok);
    expect(received).toMatchObject({ status: 'received', property: { id: 'cand1', title: 'Hotel Sunrise Manali', town: 'Kullu' }, bookingId: null, staysPath: null });
    expect(received.respondBy).toBeInstanceOf(Date);
    await b.svc.notAvailable(b.id, 'a-main');
    const gone: any = await b.svc.getPublic(b.r.publicRef, tok);
    expect(gone).toMatchObject({ status: 'unavailable', staysPath: '/stays?q=Kullu', respondBy: null, bookingId: null });
  });

  it('exposes the booking id only when the request was converted', async () => {
    const b = await candidateRequest();
    Object.assign(b.inquiries.rows[0], { state: 'CONVERTED', converted_booking_id: 'bk9' });
    const pub: any = await b.svc.getPublic(b.r.publicRef, b.r.accessToken!);
    expect(pub).toMatchObject({ status: 'sent_to_owner', bookingId: 'bk9', staysPath: null, respondBy: null });
    Object.assign(b.inquiries.rows[0], { state: 'DECLINED', converted_booking_id: 'bk9' });
    expect(((await b.svc.getPublic(b.r.publicRef, b.r.accessToken!)) as any).bookingId).toBeNull();
  });

  it('a request that expired with a candidate reads as unavailable, a general one as expired', async () => {
    const b = await candidateRequest();
    b.inquiries.rows[0].state = 'EXPIRED';
    expect(((await b.svc.getPublic(b.r.publicRef, b.r.accessToken!)) as any).status).toBe('unavailable');
    const g = build();
    const r = await g.svc.create({ ...base } as any);
    g.inquiries.rows[0].state = 'EXPIRED';
    const pub: any = await g.svc.getPublic(r.publicRef, r.accessToken!);
    expect(pub.status).toBe('expired');
    expect(pub.staysPath).toBeNull();
    expect(pub.property).toBeNull();
  });
});

describe('deadline sweep', () => {
  it('expires only overdue sweepable inquiries, records an event, and is idempotent', async () => {
    const { svc, inquiries, events } = build();
    await svc.create({ ...base, destination: 'A' } as any);
    await svc.create({ ...base, destination: 'B' } as any);
    await svc.create({ ...base, destination: 'C' } as any);
    await svc.create({ ...base, destination: 'D' } as any);
    inquiries.rows[0].response_due_at = new Date(Date.now() - 1000);
    inquiries.rows[1].response_due_at = new Date(Date.now() + 100000);
    inquiries.rows[2].response_due_at = new Date(Date.now() - 1000);
    inquiries.rows[2].state = 'CLOSED';
    inquiries.rows[3].response_due_at = new Date(Date.now() - 1000);
    inquiries.rows[3].state = 'HOST_RESPONDED'; // legacy row still in flight
    expect(await svc.sweepExpired()).toBe(2);
    expect(inquiries.rows.map((r: any) => r.state)).toEqual(['EXPIRED', 'NEW', 'CLOSED', 'EXPIRED']);
    expect(events.rows.some((e: any) => e.to_state === 'EXPIRED' && e.actor_id === null)).toBe(true);
    expect(await svc.sweepExpired()).toBe(0);
  });

  it('a general-form request expires silently', async () => {
    const b = build();
    await b.svc.create({ ...base } as any);
    b.notifications.dispatch.mockClear();
    b.whatsapp.sendTemplate.mockClear();
    b.inquiries.rows[0].response_due_at = new Date(Date.now() - 1000);
    expect(await b.svc.sweepExpired()).toBe(1);
    expect(b.notifications.dispatch).not.toHaveBeenCalled();
    expect(b.notifications.sendEmailToAddress).not.toHaveBeenCalled();
    expect(b.whatsapp.sendTemplate).not.toHaveBeenCalled();
  });

  it('a candidate request that expires sends the dates-unavailable notice exactly once, even across repeated sweeps', async () => {
    const b = await candidateRequest();
    b.notifications.dispatch.mockClear();
    b.whatsapp.sendTemplate.mockClear();
    b.inquiries.rows[0].response_due_at = new Date(Date.now() - 1000);
    expect(await b.svc.sweepExpired()).toBe(1);
    expect(b.inquiries.rows[0].state).toBe('EXPIRED');
    expect(dispatched(b)).toEqual(['inquiry.dates_unavailable']);
    expect(waTemplates(b)).toEqual(['stay_dates_unavailable']);
    // a stale re-run (e.g. the row is put back into a sweepable state by a retry) cannot resend
    b.inquiries.rows[0].state = 'NEW';
    expect(await b.svc.sweepExpired()).toBe(1);
    expect(dispatched(b)).toEqual(['inquiry.dates_unavailable']);
    expect(waTemplates(b)).toEqual(['stay_dates_unavailable']);
  });

  it('a failing notice does not stop the sweep', async () => {
    const b = await candidateRequest();
    b.notifications.dispatch.mockRejectedValue(new Error('x'));
    b.inquiries.rows[0].response_due_at = new Date(Date.now() - 1000);
    expect(await b.svc.sweepExpired()).toBe(1);
    expect(b.inquiries.rows[0].state).toBe('EXPIRED');
  });

  it('candidate requests get a 7-day window, general ones 24 hours', async () => {
    const b = await candidateRequest();
    expect(b.row.response_due_at.getTime() - b.row.consent_at.getTime()).toBe(RESPONSE_WINDOW_CANDIDATE_MS);
    const g = build();
    await g.svc.create({ ...base } as any);
    expect(g.inquiries.rows[0].response_due_at.getTime() - g.inquiries.rows[0].consent_at.getTime()).toBe(INQUIRY_RESPONSE_WINDOW_MS);
  });
});

describe('token helpers', () => {
  it('hash is deterministic, not the token, and comparison is exact', () => {
    const t = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const h = hashToken(t);
    expect(h).not.toContain(t);
    expect(tokenMatches(t, h)).toBe(true);
    expect(tokenMatches(t + 'x', h)).toBe(false);
    expect(tokenMatches('short', h)).toBe(false);
    expect(tokenMatches(undefined, h)).toBe(false);
  });
});

describe('InquiriesScheduler', () => {
  afterEach(() => setLockBackends(undefined));
  it('enqueues a sweep job when it holds the lock; sweeps inline if the queue is down; skips when not leader', async () => {
    setLockBackends([{ acquire: async () => async () => undefined }]);
    const service = { sweepExpired: jest.fn().mockResolvedValue(0) };
    const queues = { enqueue: jest.fn().mockResolvedValue({}) };
    await new InquiriesScheduler(service as any, queues as any).tick();
    expect(queues.enqueue).toHaveBeenCalledWith('automation', 'inquiries.expire-sweep', {}, expect.objectContaining({ idempotencyKey: expect.any(String) }));
    expect(service.sweepExpired).not.toHaveBeenCalled();

    queues.enqueue.mockRejectedValue(new Error('REDIS_URL is not set'));
    await new InquiriesScheduler(service as any, queues as any).tick();
    expect(service.sweepExpired).toHaveBeenCalledTimes(1);

    setLockBackends([{ acquire: async () => null }]);
    await new InquiriesScheduler(service as any, queues as any).tick();
    expect(service.sweepExpired).toHaveBeenCalledTimes(1);
  });
});


describe('logged-in request (no form)', () => {
  const withUsers = (users: any[]) => build({ users });

  it('normalises account phone numbers to E.164 and rejects non-mobile values', () => {
    expect(InquiriesService.toE164('+919876543210')).toBe('+919876543210');
    expect(InquiriesService.toE164('98765 43210')).toBe('+919876543210');
    expect(InquiriesService.toE164('919876543210')).toBe('+919876543210');
    expect(InquiriesService.toE164('09876543210')).toBe('+919876543210');
    expect(InquiriesService.toE164('12345')).toBeNull();
    expect(InquiriesService.toE164(null)).toBeNull();
  });

  it('creates the inquiry from the account alone: name, phone, email, user id, destination and its own consent version', async () => {
    const { svc, inquiries } = withUsers([{ id: 'u1', full_name: 'Asha Verma', phone: '98765 43210', email: 'Asha@Example.com' }]);
    const r = await svc.createForUser('u1', { candidateRef: 'cand1', checkIn: undefined, guests: 2 } as any);
    expect(r.publicRef).toMatch(/^RQ-/);
    expect(r.accessToken).toBeTruthy();
    const row = inquiries.rows[0];
    expect(row).toMatchObject({
      guest_user_id: 'u1',
      guest_name: 'Asha Verma',
      guest_phone: '+919876543210',
      guest_email: 'asha@example.com',
      candidate_listing_id: 'cand1',
      destination: 'Manali',
      consent_contact: true,
      state: 'NEW',
    });
    expect(row.consent_text_version).toMatch(/account-request$/);
  });

  it('asks for a mobile number only when the account has none (PHONE_REQUIRED) and creates nothing', async () => {
    const { svc, inquiries } = withUsers([{ id: 'u2', full_name: 'No Phone', phone: null, email: 'n@x.com' }]);
    await expect(svc.createForUser('u2', { candidateRef: 'cand1' } as any)).rejects.toThrow(/PHONE_REQUIRED/);
    expect(inquiries.rows).toHaveLength(0);
  });

  it('only accepts a discovered candidate or a live listing, with the same error otherwise', async () => {
    const { svc, inquiries } = withUsers([{ id: 'u1', full_name: 'Asha', phone: GUEST_PHONE, email: null }]);
    await expect(svc.createForUser('u1', { candidateRef: 'live1' } as any)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.createForUser('u1', {} as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(inquiries.rows).toHaveLength(0);
  });

  it('uses the number the guest signed in with (session token) even when the profile has no phone', async () => {
    const { svc, inquiries } = withUsers([{ id: 'u4', full_name: 'Phone Login', phone: null, email: null }]);
    const r = await svc.createForUser('u4', { candidateRef: 'cand1' } as any, { tokenPhone: '+919811122233' });
    expect(r.publicRef).toMatch(/^RQ-/);
    expect(inquiries.rows[0]).toMatchObject({ guest_user_id: 'u4', guest_phone: '+919811122233' });
  });

  it('falls back to "Guest" when the account has no usable name', async () => {
    const { svc, inquiries } = withUsers([{ id: 'u3', full_name: null, phone: GUEST_PHONE, email: null }]);
    await svc.createForUser('u3', { candidateRef: 'cand1' } as any);
    expect(inquiries.rows[0].guest_name).toBe('Guest');
  });
});

describe('admin inquiry detail: the requested property and its owner contact', () => {
  const make = (contact: any) => {
    const b = build();
    const getContact = jest.fn(async () => contact);
    (b.svc as any).places = { getContact };
    return { ...b, getContact };
  };

  it('shows staff the property and the owner phone fetched live, and stores none of it', async () => {
    const { svc, inquiries, getContact, events, messages } = make({ name: 'Ara Homestay', address: 'Old Manali', phone: OWNER_PHONE_TEXT, mapsUrl: 'https://maps.google.com/?cid=1' });
    await svc.create({ ...base, candidateRef: 'cand1' } as any);
    const d: any = await svc.detail(inquiries.rows[0].id);
    expect(getContact).toHaveBeenCalledWith('ChIJabcdefghij1', expect.any(Number));
    expect(d.candidate).toMatchObject({ listingId: 'cand1', name: 'Ara Homestay', phone: OWNER_PHONE_TEXT, district: 'Kullu', tehsil: 'Manali', claimed: false, town: 'Kullu' });
    expect(JSON.stringify([inquiries.rows, events.rows, messages.rows])).not.toMatch(/98160|Ara Homestay|Old Manali/);
  });

  it('still returns the property (without a phone) when Google has no number or is unavailable', async () => {
    const { svc, inquiries } = make(null);
    await svc.create({ ...base, candidateRef: 'cand1' } as any);
    const d: any = await svc.detail(inquiries.rows[0].id);
    expect(d.candidate).toMatchObject({ listingId: 'cand1', name: null, phone: null });
  });

  it('has no candidate block for an inquiry that is not about an unclaimed property', async () => {
    const { svc, inquiries } = make({ name: 'x', phone: '+91 1' });
    await svc.create({ ...base } as any);
    const d: any = await svc.detail(inquiries.rows[0].id);
    expect(d.candidate).toBeNull();
  });

  it('says whether the request can be sent to the owner yet, and why not (from stored columns only)', async () => {
    const { svc, inquiries, listings, getContact } = make(null);
    await svc.create({ ...base, candidateRef: 'cand1', checkIn: CI, checkOut: CO } as any);
    const id = inquiries.rows[0].id;
    let d: any = await svc.detail(id);
    expect(d.candidate.ready).toEqual({ ok: false, reason: 'The owner has not claimed this property yet' });
    expect(d.has_account).toBe(false);
    const row = listings.rows.find((l: any) => l.id === 'cand1');
    Object.assign(row, { is_discovered: false, host_id: 'h9', status: 'draft' });
    d = await svc.detail(id);
    expect(d.candidate.claimed).toBe(true);
    expect(d.candidate.ready.reason).toMatch(/still draft/);
    Object.assign(row, { status: 'live', booking_eligible: true });
    inquiries.rows[0].guest_user_id = 'u1';
    d = await svc.detail(id);
    expect(d.candidate.ready).toEqual({ ok: true });
    expect(d.has_account).toBe(true);
    expect(getContact).not.toHaveBeenCalledWith(undefined, expect.anything());
  });

  it('returns internal notes (author, body, time), notices and the booking reference; no alternatives or in/out messages', async () => {
    const b = await candidateRequest();
    b.messages.rows.push({ id: 'm-out', inquiry_id: b.id, direction: 'out', channel: 'whatsapp', body: 'LEGACY-OUT', actor_id: 'x', at: new Date() });
    await b.svc.contacting(b.id, 'a-main', 'called owner');
    const d: any = await b.svc.detail(b.id);
    expect(d).not.toHaveProperty('alternatives');
    expect(d.messages).toEqual([expect.objectContaining({ author: 'a-main', body: 'called owner', created_at: expect.any(Date) })]);
    expect(JSON.stringify(d.messages)).not.toMatch(/LEGACY-OUT/);
    expect(d.notices).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'received', to: 'guest', channel: 'email', status: 'sent' })]));
    expect(JSON.stringify(d.notices)).not.toMatch(/9876543210|asha@example/);
    expect(d.convertedBookingId).toBeNull();
    expect(d.bookingReference).toBeNull();
    expect(d).not.toHaveProperty('access_token_hash');
    Object.assign(b.inquiries.rows[0], { state: 'CONVERTED', converted_booking_id: 'bk1' });
    const c: any = await b.svc.detail(b.id);
    expect(c).toMatchObject({ convertedBookingId: 'bk1', bookingReference: 'RB-AAAAAA' });
  });
});

describe('new requests go to the primary admin', () => {
  const withAdmins = (admins: any[]) => build({ users: admins });

  it('assigns a new inquiry to admin@rhenbasera.com (NEW -> ASSIGNED), records it as a system action and notifies only that admin', async () => {
    const { svc, inquiries, events, notifications } = withAdmins([
      { id: 'a-other', role: 'admin', email: 'someone.else@example.com' },
      { id: 'a-main', role: 'admin', email: 'Admin@RhenBasera.com' },
    ]);
    await svc.create({ ...base } as any);
    await tick();
    const row = inquiries.rows[0];
    expect(row.assigned_to).toBe('a-main');
    expect(row.state).toBe('ASSIGNED');
    expect(events.rows.map((e: any) => e.type)).toEqual(expect.arrayContaining(['created', 'assigned', 'state_changed']));
    expect(events.rows.find((e: any) => e.type === 'assigned').actor_id ?? null).toBeNull();
    const to = notifications.dispatch.mock.calls.filter((c: any[]) => c[0] === 'inquiry.new').map((c: any) => c[1]);
    expect(to).toEqual(['a-main']);
  });

  it('leaves the inquiry NEW and notifies every admin when no admin has the primary email', async () => {
    const { svc, inquiries, notifications } = withAdmins([
      { id: 'a1', role: 'admin', email: 'one@example.com' },
      { id: 'a2', role: 'admin', email: 'two@example.com' },
    ]);
    await svc.create({ ...base } as any);
    await tick();
    expect(inquiries.rows[0].assigned_to).toBeFalsy();
    expect(inquiries.rows[0].state).toBe('NEW');
    expect(notifications.dispatch.mock.calls.filter((c: any[]) => c[0] === 'inquiry.new').map((c: any) => c[1]).sort()).toEqual(['a1', 'a2']);
  });
});
