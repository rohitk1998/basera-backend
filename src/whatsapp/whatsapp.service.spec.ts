import { createHmac } from 'crypto';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { WhatsappWebhookController } from './whatsapp-webhook.controller';
import { verifyMetaSignature } from './whatsapp-signature.util';

const cfg = (o: Record<string, string>) => ({ get: (k: string) => o[k] }) as any;
const params = { host_name: 'A', listing_title: 'B', inquiry_url: 'https://x' };
const GOOD = { WHATSAPP_PHONE_NUMBER_ID: '123', WHATSAPP_ACCESS_TOKEN: 'tok' };

function make(env: Record<string, string>, granted = true) {
  const repo: any = { insert: jest.fn(), findOne: jest.fn(), update: jest.fn() };
  const consent = { hasGrantedConsent: jest.fn().mockResolvedValue(granted), recordRevocation: jest.fn() };
  return { svc: new WhatsappService(cfg(env), repo, consent), repo, consent };
}

describe('WhatsappService.sendTemplate', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('blocks when not configured without calling fetch', async () => {
    global.fetch = jest.fn() as any;
    const { svc } = make({});
    expect(await svc.sendTemplate({ to: '+919876543210', template: 'inquiry_alert', params })).toEqual({ status: 'blocked', reason: 'blocked: not configured' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects bad E.164 and missing consent', async () => {
    const a = make(GOOD);
    expect((await a.svc.sendTemplate({ to: '9876543210', template: 'inquiry_alert', params })).status).toBe('blocked');
    const b = make(GOOD, false);
    expect(await b.svc.sendTemplate({ to: '+919876543210', template: 'inquiry_alert', params })).toEqual({ status: 'blocked', reason: 'blocked: no consent' });
  });

  it('posts to Graph API and records message id', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.1' }] }) }) as any;
    const { svc, repo } = make(GOOD);
    const r = await svc.sendTemplate({ to: '+919876543210', template: 'inquiry_alert', params });
    expect(r).toEqual({ status: 'sent', waMessageId: 'wamid.1', dryRun: false });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://graph.facebook.com/v21.0/123/messages');
    expect(JSON.parse(init.body).to).toBe('919876543210');
    expect(repo.insert).toHaveBeenCalledWith(expect.objectContaining({ wa_message_id: 'wamid.1', status: 'sent' }));
  });

  it('dry run never calls fetch', async () => {
    global.fetch = jest.fn() as any;
    const { svc } = make({ WHATSAPP_DRY_RUN: 'true' });
    const r = await svc.sendTemplate({ to: '+919876543210', template: 'inquiry_alert', params });
    expect(r.status).toBe('queued');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns blocked on Meta error', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { code: 131030, message: 'not allowed' } }) }) as any;
    const { svc } = make(GOOD);
    const r = await svc.sendTemplate({ to: '+919876543210', template: 'inquiry_alert', params });
    expect(r.status).toBe('blocked');
  });
});

describe('webhook handling', () => {
  it('status updates are forward-only and idempotent', async () => {
    const { svc, repo } = make(GOOD);
    repo.findOne.mockResolvedValueOnce({ id: '1', status: 'sent', error: null });
    expect((await svc.handleWebhook({ entry: [{ changes: [{ value: { statuses: [{ id: 'w', status: 'delivered' }] } }] }] })).statuses).toBe(1);
    repo.findOne.mockResolvedValueOnce({ id: '1', status: 'delivered', error: null });
    expect((await svc.handleWebhook({ entry: [{ changes: [{ value: { statuses: [{ id: 'w', status: 'delivered' }] } }] }] })).statuses).toBe(0);
    expect(repo.update).toHaveBeenCalledTimes(1);
  });

  it('inbound STOP records revocation; duplicate does not', async () => {
    const { svc, repo, consent } = make(GOOD);
    const exec = jest.fn().mockResolvedValueOnce({ identifiers: [{ id: 'x' }] }).mockResolvedValueOnce({ identifiers: [{}] });
    repo.createQueryBuilder = () => ({ insert: () => ({ values: () => ({ orIgnore: () => ({ execute: exec }) }) }) });
    const body = { entry: [{ changes: [{ value: { messages: [{ id: 'm1', from: '919876543210', type: 'text', text: { body: ' STOP ' } }] } }] }] };
    await svc.handleWebhook(body);
    await svc.handleWebhook(body);
    expect(consent.recordRevocation).toHaveBeenCalledTimes(1);
    expect(consent.recordRevocation).toHaveBeenCalledWith('+919876543210', expect.any(String));
  });
});

describe('WhatsappWebhookController', () => {
  const ctl = () => new WhatsappWebhookController(cfg({ WHATSAPP_VERIFY_TOKEN: 'vt', WHATSAPP_APP_SECRET: 'sec' }), { handleWebhook: jest.fn() } as any);
  it('GET verification', () => {
    expect(ctl().verify('subscribe', 'vt', 'abc')).toBe('abc');
    expect(() => ctl().verify('subscribe', 'bad', 'abc')).toThrow(ForbiddenException);
  });
  it('POST requires valid HMAC over raw body', async () => {
    const raw = Buffer.from('{"entry":[]}');
    const sig = 'sha256=' + createHmac('sha256', 'sec').update(raw).digest('hex');
    const mk = (h: string) => ({ rawBody: raw, header: () => h }) as any;
    await expect(ctl().receive(mk(sig))).resolves.toEqual({ received: true });
    await expect(ctl().receive(mk('sha256=00'))).rejects.toThrow(UnauthorizedException);
    expect(verifyMetaSignature(raw, undefined, 'sec')).toBe(false);
  });
});
