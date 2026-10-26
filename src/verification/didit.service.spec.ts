import { ConfigService } from '@nestjs/config';
import { canonicalJson, DiditService, signWebhookBody } from './didit.service';

const CANONICAL = '{"a":1,"b":[{"x":"é","y":2}],"z":{"k":null,"m":true}}';
const EXPECTED_HMAC = '4b40c9991b37621f8e2a2c5288359b2ae2c54a44cf03ef254c1016f4b114d14e';
const body = { z: { m: true, k: null }, b: [{ y: 2.0, x: 'é' }], a: 1 };

const service = (secret: string | undefined = 'whsec_test') =>
  new DiditService({ get: (k: string) => (k === 'DIDIT_WEBHOOK_SECRET' ? secret : undefined) } as unknown as ConfigService);

describe('Didit webhook signature', () => {
  it('canonicalises: sorted keys, compact, whole floats as integers, Unicode kept', () => {
    expect(canonicalJson(body)).toBe(CANONICAL);
  });

  it('matches the hand-computed HMAC-SHA256', () => {
    expect(signWebhookBody(body, 'whsec_test')).toBe(EXPECTED_HMAC);
  });

  it('accepts a correct signature on a fresh event', () => {
    const b = { ...body, timestamp: 1_700_000_000 };
    const sig = signWebhookBody(b, 'whsec_test');
    expect(service().verifyWebhook(b, sig, 1_700_000_100_000)).toBe('ok');
  });

  it('rejects stale timestamps (both directions) and tampered bodies', () => {
    const b = { ...body, timestamp: 1_700_000_000 };
    const sig = signWebhookBody(b, 'whsec_test');
    expect(service().verifyWebhook(b, sig, 1_700_000_301_000)).toBe('stale');
    expect(service().verifyWebhook(b, sig, 1_699_999_699_000)).toBe('stale');
    expect(service().verifyWebhook({ ...b, a: 2 }, sig, 1_700_000_000_000)).toBe('bad_signature');
  });

  it('rejects missing, short and wrong signatures; reports a missing secret', () => {
    const b = { timestamp: 1_700_000_000 };
    expect(service().verifyWebhook(b, undefined, 1_700_000_000_000)).toBe('bad_signature');
    expect(service().verifyWebhook(b, 'abc', 1_700_000_000_000)).toBe('bad_signature');
    expect(service().verifyWebhook(b, signWebhookBody(b, 'other'), 1_700_000_000_000)).toBe('bad_signature');
    expect(service('').verifyWebhook(b, 'x')).toBe('not_configured');
  });
});
