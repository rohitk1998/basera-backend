import { Logger } from '@nestjs/common';
import { describeFcmError, parseFcmError } from './fcm-errors';
import { NotificationsService } from './notifications.service';

const TOKEN = 'dX9aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789_secret_registration_token_value';

describe('parseFcmError', () => {
  it('reads status and errorCode and flags UNREGISTERED as dead', () => {
    const info = parseFcmError(
      404,
      JSON.stringify({ error: { code: 404, status: 'NOT_FOUND', message: 'Requested entity was not found.', details: [{ errorCode: 'UNREGISTERED' }] } }),
    );
    expect(info).toMatchObject({ httpStatus: 404, status: 'NOT_FOUND', errorCode: 'UNREGISTERED', tokenDead: true });
  });

  it('treats an invalid registration token as dead but a bad payload as not', () => {
    const bad = (message: string) => JSON.stringify({ error: { status: 'INVALID_ARGUMENT', message } });
    expect(parseFcmError(400, bad('The registration token is not a valid FCM registration token')).tokenDead).toBe(true);
    expect(parseFcmError(400, bad('Invalid JSON payload received.')).tokenDead).toBe(false);
  });

  it('does not prune on auth/permission errors', () => {
    for (const status of ['UNAUTHENTICATED', 'PERMISSION_DENIED']) {
      expect(parseFcmError(403, JSON.stringify({ error: { status, message: 'nope' } })).tokenDead).toBe(false);
    }
  });

  it('survives a non-JSON body and redacts token-like strings', () => {
    const info = parseFcmError(502, `<html>bad gateway ${TOKEN}</html>`);
    expect(info.tokenDead).toBe(false);
    expect(describeFcmError(info)).not.toContain(TOKEN);
  });
});

describe('NotificationsService push failure handling', () => {
  let warn: jest.SpyInstance;
  const profiles = { findOne: jest.fn(), update: jest.fn() };
  const config = { get: jest.fn((k: string) => (k === 'FIREBASE_PROJECT_ID' ? 'proj' : undefined)) };
  const service = new NotificationsService(profiles as never, {} as never, config as never);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = service as any;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    profiles.findOne.mockReset();
    profiles.update.mockReset();
    svc.fcmToken = 'BEARER-SECRET';
    svc.fcmTokenExpiry = Date.now() + 60_000;
  });
  afterEach(() => jest.restoreAllMocks());

  it('logs status and code, never the token or bearer, and reports the token stale', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: { status: 'NOT_FOUND', message: 'gone', details: [{ errorCode: 'UNREGISTERED' }] } }),
    }) as never;
    const out = await svc.sendPush([TOKEN], 't', 'b', undefined);
    expect(out.staleTokens).toEqual([TOKEN]);
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('UNREGISTERED');
    expect(logged).toContain('http=404');
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain('BEARER-SECRET');
  });

  it('logs a thrown network error and keeps the token', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('socket hang up')) as never;
    const out = await svc.sendPush([TOKEN], 't', 'b', undefined);
    expect(out.staleTokens).toEqual([]);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('socket hang up');
  });

  it('prunes only dead tokens, from a fresh read of the row', async () => {
    profiles.findOne.mockResolvedValue({ id: 'u1', fcm_tokens: ['dead', 'new', 'live'] });
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    await service.pruneTokens('u1', ['dead']);
    expect(profiles.update).toHaveBeenCalledWith({ id: 'u1' }, { fcm_tokens: ['new', 'live'] });
  });
});
