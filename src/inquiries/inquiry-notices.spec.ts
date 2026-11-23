import { InquiryAdminNotices } from './inquiry-admin-notices.service';
import { GUEST_BOOKINGS_PATH, InquiryGuestNotices } from './inquiry-guest-notices.service';
import { InquiryNoticeCore } from './inquiry-notice-core.service';

/** In-memory inquiry_events repo that answers the dedupe count query. */
function fakeEvents() {
  const rows: any[] = [];
  return {
    rows,
    create: (x: any) => ({ ...x }),
    save: jest.fn(async (x: any) => (rows.push(x), x)),
    createQueryBuilder: () => {
      const p: Record<string, string> = {};
      const qb: any = {
        where: (_s: string, v: any) => (Object.assign(p, { id: v.id }), qb),
        andWhere: (_s: string, v?: any) => (v && Object.assign(p, v), qb),
        getCount: async () =>
          rows.filter((r) => r.type === 'notice' && r.inquiry_id === p.id && r.meta.kind === p.kind && r.meta.to === p.to && r.meta.channel === p.channel).length,
      };
      return qb;
    },
  };
}

interface Env { [k: string]: string | undefined }

function build(env: Env = {}, consentRow: any = null) {
  const events = fakeEvents();
  const listings = {
    findOne: jest.fn().mockResolvedValue({
      id: 'cand1',
      draft_data: { property_details: { title: 'Hotel Sunrise Manali' } },
      disc_district: 'Manali',
      discovery_destination: 'Kullu',
    }),
  };
  const whatsapp = { sendTemplate: jest.fn().mockResolvedValue({ status: 'queued', waMessageId: 'w1', dryRun: false }) };
  const consent = { get: jest.fn().mockResolvedValue(consentRow), set: jest.fn().mockResolvedValue(undefined) };
  const config = { get: (k: string) => env[k] };
  const notifications = {
    dispatch: jest.fn().mockResolvedValue([{ channel: 'in_app', status: 'sent' }, { channel: 'email', status: 'sent' }]),
    sendEmailToAddress: jest.fn().mockResolvedValue('sent'),
  };
  const users = {
    find: jest.fn().mockResolvedValue([{ id: 'adminA' }, { id: 'adminB' }]),
    findOne: jest.fn().mockResolvedValue({ id: 'adminA', full_name: 'Priya Sharma' }),
  };
  const core = new InquiryNoticeCore(events as any, listings as any, whatsapp as any, consent as any, config as any);
  const guest = new InquiryGuestNotices(core, notifications as any);
  const admin = new InquiryAdminNotices(core, notifications as any, users as any);
  return { core, guest, admin, events, listings, whatsapp, consent, notifications, users };
}

const inq = (o: any = {}): any => ({
  id: 'q1',
  public_ref: 'RQ-AJTZ9R',
  guest_user_id: 'u1',
  guest_name: 'Asha',
  guest_phone: '+919876543210',
  guest_email: 'asha@example.com',
  candidate_listing_id: 'cand1',
  target_listing_id: null,
  destination: 'Manali',
  check_in: '2026-12-12',
  check_out: '2026-12-15',
  guests: 2,
  ...o,
});

describe('InquiryNoticeCore helpers', () => {
  const { core } = build({ APP_URL: 'https://x.test///' });
  it('formats dates in en-GB style without timezone drift', () => {
    expect(core.formatDate('2026-12-12')).toBe('12 Dec 2026');
    expect(core.formatDate('2026-01-01')).toBe('1 Jan 2026');
    expect(core.formatDate(new Date('2026-12-15T00:00:00Z'))).toBe('15 Dec 2026');
  });
  it('staysPath encodes the town and falls back to /stays', () => {
    expect(core.staysPath('Manali')).toBe('/stays?q=Manali');
    expect(core.staysPath('Old Manali & Naggar')).toBe('/stays?q=Old%20Manali%20%26%20Naggar');
    expect(core.staysPath('')).toBe('/stays');
  });
  it('appUrl strips trailing slashes and has a default', () => {
    expect(core.appUrl()).toBe('https://x.test');
    expect(build({}).core.appUrl()).toBe('https://www.rhenbasera.online');
  });
  it('adminWhatsappNumber reads ADMIN_WHATSAPP_NUMBER or null', () => {
    expect(build({ ADMIN_WHATSAPP_NUMBER: '+919999900000' }).core.adminWhatsappNumber()).toBe('+919999900000');
    expect(build({}).core.adminWhatsappNumber()).toBeNull();
  });
  it('resolveProperty uses stored listing columns, falling back to the inquiry destination', async () => {
    const b = build();
    await expect(b.core.resolveProperty(inq())).resolves.toEqual({ propertyName: 'Hotel Sunrise Manali', town: 'Manali' });
    b.listings.findOne.mockResolvedValueOnce(null);
    await expect(b.core.resolveProperty(inq())).resolves.toEqual({ propertyName: 'the property', town: 'Manali' });
    b.listings.findOne.mockRejectedValueOnce(new Error('db down'));
    await expect(b.core.resolveProperty(inq())).resolves.toMatchObject({ town: 'Manali' });
    const sel = b.listings.findOne.mock.calls[0][0].select;
    expect(Object.keys(sel).sort()).toEqual(['discovery_destination', 'disc_district', 'draft_data', 'id'].sort());
  });
});

describe('InquiryNoticeCore.once', () => {
  it('runs once per (inquiry, kind, to, channel), records an event without contact details, then reports duplicate', async () => {
    const { core, events } = build();
    const send = jest.fn().mockResolvedValue({ status: 'sent' });
    expect(await core.once(inq(), 'received', 'guest', 'email', send)).toEqual({ status: 'sent', reason: undefined });
    expect(await core.once(inq(), 'received', 'guest', 'email', send)).toEqual({ status: 'duplicate' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(events.rows[0]).toMatchObject({ type: 'notice', inquiry_id: 'q1', meta: { kind: 'received', to: 'guest', channel: 'email', status: 'sent' } });
    expect(JSON.stringify(events.rows)).not.toMatch(/9876543210|@example/);
    // other channel / kind are independent
    await core.once(inq(), 'received', 'guest', 'whatsapp', send);
    await core.once(inq(), 'unavailable', 'guest', 'email', send);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('a throwing sender becomes failed and never throws', async () => {
    const { core, events } = build();
    const r = await core.once(inq(), 'unavailable', 'guest', 'email', async () => { throw new Error('smtp down'); });
    expect(r.status).toBe('failed');
    expect(events.rows[0].meta).toMatchObject({ status: 'failed' });
  });

  it('survives a broken dedupe lookup and a broken event write', async () => {
    const { core, events } = build();
    (events as any).createQueryBuilder = () => { throw new Error('lookup'); };
    events.save.mockRejectedValueOnce(new Error('write'));
    const r = await core.once(inq(), 'received', 'guest', 'email', async () => ({ status: 'sent' }));
    expect(r.status).toBe('sent');
  });
});

describe('InquiryNoticeCore.sendWhatsapp', () => {
  const params = { guest_name: 'Asha', property_name: 'Hotel', check_in_date: 'a', check_out_date: 'b' };

  it('sends through WhatsappService with the inquiry as related record and grants consent first', async () => {
    const { core, whatsapp, consent } = build();
    const r = await core.sendWhatsapp(inq(), '+919876543210', 'stay_request_received', params, 'inquiry:q1:received');
    expect(r.status).toBe('sent');
    expect(consent.set).toHaveBeenCalledWith('phone', '+919876543210', 'whatsapp', 'granted', 'inquiry:q1:received');
    expect(whatsapp.sendTemplate).toHaveBeenCalledWith({ to: '+919876543210', template: 'stay_request_received', params, relatedType: 'inquiry', relatedId: 'q1' });
  });

  it('blocked becomes skipped with the reason (consent gate is the WhatsappService, never bypassed)', async () => {
    const { core, whatsapp } = build();
    whatsapp.sendTemplate.mockResolvedValue({ status: 'blocked', reason: 'blocked: no consent' });
    expect(await core.sendWhatsapp(inq(), '+919876543210', 'stay_request_received', params, 's')).toEqual({ status: 'skipped', reason: 'blocked: no consent' });
    whatsapp.sendTemplate.mockResolvedValue({ status: 'blocked', reason: 'blocked: not configured' });
    expect(await core.sendWhatsapp(inq(), '+919876543210', 'stay_request_received', params, 's')).toEqual({ status: 'skipped', reason: 'blocked: not configured' });
  });

  it('a throwing provider is failed, not thrown', async () => {
    const { core, whatsapp } = build();
    whatsapp.sendTemplate.mockRejectedValue(new Error('network'));
    expect((await core.sendWhatsapp(inq(), '+919876543210', 'stay_request_received', params, 's')).status).toBe('failed');
  });

  it.each([[null], [undefined], [''], ['98765 43210'], ['+12'], ['abc']])('a missing or invalid phone (%p) is skipped as no_phone and sends nothing', async (phone) => {
    const { core, whatsapp, consent } = build();
    expect(await core.sendWhatsapp(inq(), phone as any, 'stay_request_received', params, 's')).toEqual({ status: 'skipped', reason: 'no_phone' });
    expect(whatsapp.sendTemplate).not.toHaveBeenCalled();
    expect(consent.set).not.toHaveBeenCalled();
  });

  it('flattens newlines, tabs and long space runs in params', async () => {
    const { core, whatsapp } = build();
    await core.sendWhatsapp(inq(), '+919876543210', 'stay_request_received', { ...params, guest_name: 'As\nha\t  x      y' }, 's');
    const sent = whatsapp.sendTemplate.mock.calls[0][0].params.guest_name;
    expect(sent).not.toMatch(/[\n\t]/);
    expect(sent).not.toMatch(/ {4,}/);
  });
});

describe('InquiryNoticeCore.ensureConsent / grantGuestConsentOnCreate', () => {
  it('grants when missing or unknown', async () => {
    const a = build({}, null);
    await a.core.ensureConsent('+919876543210', 'src');
    expect(a.consent.set).toHaveBeenCalledWith('phone', '+919876543210', 'whatsapp', 'granted', 'src');
    const b = build({}, { consent_status: 'unknown' });
    await b.core.ensureConsent('+919876543210', 'src');
    expect(b.consent.set).toHaveBeenCalled();
  });
  it('never re-grants a revoked number and does not rewrite a granted one', async () => {
    const r = build({}, { consent_status: 'revoked' });
    await r.core.ensureConsent('+919876543210', 'src');
    expect(r.consent.set).not.toHaveBeenCalled();
    const g = build({}, { consent_status: 'granted' });
    await g.core.ensureConsent('+919876543210', 'src');
    expect(g.consent.set).not.toHaveBeenCalled();
  });
  it('swallows consent store errors', async () => {
    const b = build();
    b.consent.get.mockRejectedValue(new Error('db'));
    await expect(b.core.ensureConsent('+919876543210', 's')).resolves.toBeUndefined();
    await expect(b.core.grantGuestConsentOnCreate(inq())).resolves.toBeUndefined();
  });
  it('grantGuestConsentOnCreate uses the inquiry source tag', async () => {
    const b = build();
    await b.core.grantGuestConsentOnCreate(inq());
    expect(b.consent.set).toHaveBeenCalledWith('phone', '+919876543210', 'whatsapp', 'granted', 'inquiry:q1:request');
  });
});

describe('InquiryGuestNotices', () => {
  it('account guest: email via dispatch (deduped), WhatsApp via template with absolute URLs', async () => {
    const { guest, notifications, whatsapp } = build({ APP_URL: 'https://app.test' });
    const res = await guest.datesUnavailable(inq(), 'admin');
    expect(res).toMatchObject({ email: 'sent', whatsapp: 'sent' });
    expect(notifications.sendEmailToAddress).not.toHaveBeenCalled();
    const [event, userId, data, opts] = notifications.dispatch.mock.calls[0];
    expect(event).toBe('inquiry.dates_unavailable');
    expect(userId).toBe('u1');
    expect(opts).toEqual({ dedupeKey: 'inquiry:q1:unavailable' });
    expect(data).toMatchObject({ propertyName: 'Hotel Sunrise Manali', town: 'Manali', checkIn: '12 Dec 2026', checkOut: '15 Dec 2026', guests: 2, link: '/stays?q=Manali', ref: 'RQ-AJTZ9R' });
    const wa = whatsapp.sendTemplate.mock.calls[0][0];
    expect(wa.template).toBe('stay_dates_unavailable');
    expect(wa.params).toEqual({ guest_name: 'Asha', property_name: 'Hotel Sunrise Manali', check_in_date: '12 Dec 2026', check_out_date: '15 Dec 2026', stays_url: 'https://app.test/stays?q=Manali' });
  });

  it('anonymous guest: stored email address and phone are used directly', async () => {
    const { guest, notifications, whatsapp } = build();
    const res = await guest.received(inq({ guest_user_id: null }));
    expect(res).toMatchObject({ email: 'sent', whatsapp: 'sent' });
    expect(notifications.dispatch).not.toHaveBeenCalled();
    const [to, event, data] = notifications.sendEmailToAddress.mock.calls[0];
    expect(to).toBe('asha@example.com');
    expect(event).toBe('inquiry.guest_received');
    expect(data.link).toBeUndefined();
    expect(whatsapp.sendTemplate.mock.calls[0][0].to).toBe('+919876543210');
  });

  it('anonymous guest without an email skips email but still sends WhatsApp', async () => {
    const { guest, notifications, whatsapp } = build();
    const res = await guest.received(inq({ guest_user_id: null, guest_email: null }));
    expect(res).toMatchObject({ email: 'skipped', whatsapp: 'sent' });
    expect(res.reasons?.email).toBe('no_email');
    expect(notifications.sendEmailToAddress).not.toHaveBeenCalled();
    expect(whatsapp.sendTemplate).toHaveBeenCalledTimes(1);
  });

  it('a second call sends nothing (duplicate) on either channel', async () => {
    const { guest, notifications, whatsapp } = build();
    await guest.datesUnavailable(inq(), 'admin');
    const again = await guest.datesUnavailable(inq(), 'sweep');
    expect(again).toMatchObject({ email: 'duplicate', whatsapp: 'duplicate' });
    expect(notifications.dispatch).toHaveBeenCalledTimes(1);
    expect(whatsapp.sendTemplate).toHaveBeenCalledTimes(1);
  });

  it('email failing does not stop WhatsApp, and WhatsApp blocked does not stop email; neither throws', async () => {
    const a = build();
    a.notifications.dispatch.mockRejectedValue(new Error('resend 500'));
    expect(await a.guest.received(inq())).toMatchObject({ email: 'failed', whatsapp: 'sent' });
    const b = build();
    b.whatsapp.sendTemplate.mockResolvedValue({ status: 'blocked', reason: 'blocked: no consent' });
    const r = await b.guest.received(inq());
    expect(r).toMatchObject({ email: 'sent', whatsapp: 'skipped' });
    expect(r.reasons?.whatsapp).toMatch(/consent/);
    const c = build();
    c.whatsapp.sendTemplate.mockRejectedValue(new Error('x'));
    c.notifications.dispatch.mockResolvedValue([{ channel: 'email', status: 'failed', error: '500' }]);
    expect(await c.guest.received(inq())).toMatchObject({ email: 'failed', whatsapp: 'failed' });
  });

  it('a revoked number gets no consent grant (WhatsApp then blocked by the gate)', async () => {
    const { guest, consent, whatsapp } = build({}, { consent_status: 'revoked' });
    whatsapp.sendTemplate.mockResolvedValue({ status: 'blocked', reason: 'blocked: no consent' });
    const r = await guest.received(inq());
    expect(consent.set).not.toHaveBeenCalled();
    expect(r.whatsapp).toBe('skipped');
    expect(r.email).toBe('sent');
  });

  it('requestSent links to the guest bookings page and never carries a booking id in WhatsApp text', async () => {
    const { guest, notifications, whatsapp } = build({ APP_URL: 'https://app.test' });
    await guest.requestSent(inq(), { id: 'b1', reference: 'RB-AAAAAA' });
    expect(notifications.dispatch.mock.calls[0][0]).toBe('inquiry.request_sent');
    expect(notifications.dispatch.mock.calls[0][2].link).toBe(GUEST_BOOKINGS_PATH);
    const wa = whatsapp.sendTemplate.mock.calls[0][0];
    expect(wa.template).toBe('stay_request_sent_to_owner');
    expect(wa.params.bookings_url).toBe(`https://app.test${GUEST_BOOKINGS_PATH}`);
  });

  it('payloads never contain the owner phone, Google address, maps URL or the word escrow', async () => {
    const { guest, notifications, whatsapp } = build();
    await guest.received(inq());
    await guest.requestSent(inq(), { id: 'b1', reference: 'RB-1' });
    await guest.datesUnavailable(inq(), 'admin');
    const all = JSON.stringify([notifications.dispatch.mock.calls, whatsapp.sendTemplate.mock.calls]);
    expect(all).not.toMatch(/escrow|maps\.google|mapsUrl|ownerPhone|"address"|"phone"/i);
  });
});

describe('InquiryAdminNotices', () => {
  it('emails/in-app only the assignee and WhatsApps the configured admin number with the admin template', async () => {
    const { admin, notifications, whatsapp, consent } = build({ ADMIN_WHATSAPP_NUMBER: '+919999900000', APP_URL: 'https://app.test' });
    const r = await admin.newRequest(inq(), 'adminA');
    expect(r).toMatchObject({ email: 'sent', whatsapp: 'sent' });
    expect(notifications.dispatch).toHaveBeenCalledTimes(1);
    const [event, to, data, opts] = notifications.dispatch.mock.calls[0];
    expect(event).toBe('inquiry.new');
    expect(to).toBe('adminA');
    expect(opts).toEqual({ dedupeKey: 'inquiry:q1:admin' });
    expect(data).toMatchObject({ propertyName: 'Hotel Sunrise Manali', ref: 'RQ-AJTZ9R', link: '/admin', guests: 2 });
    const wa = whatsapp.sendTemplate.mock.calls[0][0];
    expect(wa).toMatchObject({ to: '+919999900000', template: 'stay_request_admin_alert' });
    expect(wa.params).toEqual({ admin_name: 'Priya', request_ref: 'RQ-AJTZ9R', guest_name: 'Asha', property_name: 'Hotel Sunrise Manali', check_in_date: '12 Dec 2026', check_out_date: '15 Dec 2026' });
    expect(consent.set).toHaveBeenCalledWith('phone', '+919999900000', 'whatsapp', 'granted', 'staff:primary-admin');
  });

  it('skips admin WhatsApp (not_configured) without ADMIN_WHATSAPP_NUMBER, email still goes', async () => {
    const { admin, whatsapp, notifications } = build({});
    const r = await admin.newRequest(inq(), 'adminA');
    expect(r).toMatchObject({ email: 'sent', whatsapp: 'skipped' });
    expect(r.reasons?.whatsapp).toBe('not_configured');
    expect(whatsapp.sendTemplate).not.toHaveBeenCalled();
    expect(notifications.dispatch).toHaveBeenCalledTimes(1);
  });

  it('with no assignee it falls back to every admin (old behaviour), never silently to nobody', async () => {
    const { admin, notifications } = build({});
    await admin.newRequest(inq(), null);
    expect(notifications.dispatch.mock.calls.map((c) => c[1]).sort()).toEqual(['adminA', 'adminB']);
  });

  it('is deduped and never throws when everything fails', async () => {
    const { admin, notifications, whatsapp } = build({ ADMIN_WHATSAPP_NUMBER: '+919999900000' });
    notifications.dispatch.mockRejectedValue(new Error('x'));
    whatsapp.sendTemplate.mockRejectedValue(new Error('y'));
    expect(await admin.newRequest(inq(), 'adminA')).toMatchObject({ email: 'failed', whatsapp: 'failed' });
    expect(await admin.newRequest(inq(), 'adminA')).toMatchObject({ email: 'duplicate', whatsapp: 'duplicate' });
  });
});

describe('InquiryNoticeCore.sendWhatsapp dry run', () => {
  it('reports a dry-run queue as skipped (dry_run), not sent', async () => {
    const whatsapp = { sendTemplate: jest.fn().mockResolvedValue({ status: 'queued', waMessageId: 'd1', dryRun: true }) };
    const consent = { hasGrantedConsent: jest.fn().mockResolvedValue(true), grantConsent: jest.fn().mockResolvedValue(undefined) };
    const core: any = new (require('./inquiry-notice-core.service').InquiryNoticeCore)(
      { findOne: jest.fn(), insert: jest.fn(), save: jest.fn(), createQueryBuilder: jest.fn() }, {}, whatsapp, consent, { get: () => undefined },
    );
    const out = await core.sendWhatsapp({ id: 'q1' }, '+919876543210', 'stay_request_received', { a: 'b' }, 'src');
    expect(out).toEqual({ status: 'skipped', reason: 'dry_run' });
  });
});
