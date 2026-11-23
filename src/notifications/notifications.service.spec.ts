import { NotificationsService } from './notifications.service';
import { ConsentService } from './consent.service';

function build(profile: any = { id: 'u', email: 'a@b.c', notif_email: true, notif_push: false, fcm_tokens: [] }) {
  const execute = jest.fn().mockResolvedValue({ raw: [{ id: '1' }] });
  const qb: any = { insert: () => qb, into: () => qb, values: jest.fn(() => qb), orIgnore: () => qb, returning: () => qb, execute };
  const log: any = { createQueryBuilder: () => qb, create: jest.fn((x) => x), save: jest.fn(), count: jest.fn() };
  const profiles: any = { findOne: jest.fn().mockResolvedValue(profile) };
  const config: any = { get: (k: string) => ({ RESEND_API_KEY: 'k', APP_URL: 'https://x.test' } as any)[k] };
  const svc = new NotificationsService(profiles, log, config);
  return { svc, qb, log, execute };
}

describe('NotificationsService dispatch', () => {
  afterEach(() => jest.restoreAllMocks());

  it('writes an in_app row with dedupe key and a real email delivery row', async () => {
    const { svc, qb, log } = build();
    jest.spyOn(svc, 'sendEmailOnce').mockResolvedValue({ ok: true, retryable: false });
    const res = await svc.dispatch('user.welcome', 'u', {}, { dedupeKey: 'k1' });
    expect(qb.values).toHaveBeenCalledWith(expect.objectContaining({ channel: 'in_app', dedupe_key: 'k1' }));
    expect(res.map((r) => [r.channel, r.status])).toEqual([['in_app', 'sent'], ['email', 'sent']]);
    expect(log.save.mock.calls[0][0][0]).toMatchObject({ channel: 'email', status: 'sent' });
  });

  it('skips with reason duplicate when the insert conflicts', async () => {
    const { svc, execute, log } = build();
    execute.mockResolvedValue({ raw: [] });
    const send = jest.spyOn(svc, 'sendEmailOnce');
    const res = await svc.dispatch('user.welcome', 'u', {}, { dedupeKey: 'k1' });
    expect(res).toEqual([{ channel: 'in_app', status: 'skipped', reason: 'duplicate' }]);
    expect(send).not.toHaveBeenCalled();
    expect(log.save).not.toHaveBeenCalled();
  });

  it('persists failed email truthfully and retries retryable errors at most twice', async () => {
    jest.useFakeTimers();
    const { svc, log } = build();
    const send = jest.spyOn(svc, 'sendEmailOnce').mockResolvedValue({ ok: false, retryable: true, error: '503' });
    const p = svc.dispatch('booking.confirmed', 'u', {});
    await jest.runAllTimersAsync();
    const res = await p;
    jest.useRealTimers();
    expect(send).toHaveBeenCalledTimes(3);
    expect(res[1]).toMatchObject({ channel: 'email', status: 'failed', error: '503' });
    expect(log.save.mock.calls[0][0][0]).toMatchObject({ status: 'failed' });
  });

  it('does not retry non-retryable failures', async () => {
    const { svc } = build();
    const send = jest.spyOn(svc, 'sendEmailOnce').mockResolvedValue({ ok: false, retryable: false, error: '400' });
    await svc.dispatch('booking.confirmed', 'u', {});
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('unread count and list read in_app rows', async () => {
    const { svc, log } = build();
    log.count.mockResolvedValue(3);
    await svc.unreadCount('u');
    expect(log.count.mock.calls[0][0].where.channel).toBe('in_app');
  });

  it('adds List-Unsubscribe only for non-transactional events', async () => {
    const { svc } = build();
    const fetchMock = jest.fn().mockResolvedValue({ ok: true });
    (global as any).fetch = fetchMock;
    await svc.sendEmailOnce('a@b.c', 'user.registered', { userName: 'A' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).headers['List-Unsubscribe']).toContain('https://x.test/settings');
    await svc.sendEmailOnce('a@b.c', 'auth.otp_code', { code: '123456' });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).headers).toBeUndefined();
  });
});

describe('NotificationsService.sendEmailToAddress', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns sent / skipped / failed and never throws', async () => {
    const { svc } = build();
    const once = jest.spyOn(svc, 'sendEmailOnce');
    once.mockResolvedValueOnce({ ok: true, retryable: false });
    await expect(svc.sendEmailToAddress('guest@example.com', 'inquiry.guest_received', {})).resolves.toBe('sent');
    once.mockResolvedValueOnce({ ok: false, retryable: false, skipped: true });
    await expect(svc.sendEmailToAddress('guest@example.com', 'inquiry.guest_received', {})).resolves.toBe('skipped');
    once.mockResolvedValueOnce({ ok: false, retryable: false, error: '400' });
    await expect(svc.sendEmailToAddress('guest@example.com', 'inquiry.guest_received', {})).resolves.toBe('failed');
    once.mockRejectedValueOnce(new Error('boom'));
    await expect(svc.sendEmailToAddress('guest@example.com', 'inquiry.guest_received', {})).resolves.toBe('failed');
  });

  it('does not log the full address on failure', async () => {
    const { svc } = build();
    jest.spyOn(svc, 'sendEmailOnce').mockResolvedValue({ ok: false, retryable: false, error: '400' });
    const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
    await svc.sendEmailToAddress('guest.person@example.com', 'inquiry.dates_unavailable', {});
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.map((c) => String(c[0])).join(' ')).not.toContain('guest.person@example.com');
  });

  it('renders the new inquiry templates through the real Resend path', async () => {
    const { svc } = build();
    const fetchMock = jest.fn().mockResolvedValue({ ok: true });
    (global as any).fetch = fetchMock;
    const res = await svc.sendEmailToAddress('g@example.com', 'inquiry.dates_unavailable', { propertyName: 'Hotel', town: 'Manali', link: '/stays?q=Manali' });
    expect(res).toBe('sent');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.to).toEqual(expect.anything());
    expect(body.html).toContain('https://x.test/stays?q=Manali');
  });
});

describe('ConsentService', () => {
  const mk = () => {
    const repo: any = { findOne: jest.fn(), upsert: jest.fn() };
    return { repo, svc: new ConsentService(repo) };
  };
  it('allows only explicit grant', async () => {
    const { repo, svc } = mk();
    repo.findOne.mockResolvedValueOnce(null);
    expect(await svc.isAllowed('user', '1', 'whatsapp')).toBe(false);
    repo.findOne.mockResolvedValueOnce({ consent_status: 'unknown' });
    expect(await svc.isAllowed('user', '1', 'whatsapp')).toBe(false);
    repo.findOne.mockResolvedValueOnce({ consent_status: 'revoked' });
    expect(await svc.isAllowed('user', '1', 'whatsapp')).toBe(false);
    repo.findOne.mockResolvedValueOnce({ consent_status: 'granted' });
    expect(await svc.isAllowed('user', '1', 'whatsapp')).toBe(true);
  });
  it('set stamps consented_at / revoked_at', async () => {
    const { repo, svc } = mk();
    await svc.set('user', '1', 'sms', 'granted', 'signup');
    expect(repo.upsert.mock.calls[0][0]).toMatchObject({ consent_status: 'granted', revoked_at: null, source: 'signup' });
    expect(repo.upsert.mock.calls[0][0].consented_at).toBeInstanceOf(Date);
    await svc.set('user', '1', 'sms', 'revoked');
    expect(repo.upsert.mock.calls[1][0].revoked_at).toBeInstanceOf(Date);
  });
});
