import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CashfreeService } from './cashfree.service';

function build(env: Record<string, string | undefined>) {
  return new CashfreeService({ get: (k: string) => env[k] } as unknown as ConfigService);
}

function mockFetch(status: number, body: unknown) {
  const fn = jest.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => body });
  (global as any).fetch = fn;
  return fn;
}

const configured = { CASHFREE_CLIENT_ID: 'id', CASHFREE_CLIENT_SECRET: 'secret' };

describe('CashfreeService verification', () => {
  const realFetch = (global as any).fetch;
  afterEach(() => {
    (global as any).fetch = realFetch;
  });

  it('answers 503 instead of faking success when credentials are missing', async () => {
    await expect(build({}).verifyPan({ pan: 'ABCPV1234D', name: 'A B' })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('verifies a valid PAN with a matching name against the sandbox', async () => {
    const fetchFn = mockFetch(200, { valid: true, pan_status: 'VALID', name_match_result: 'DIRECT_MATCH', reference_id: 7 });
    const out = await build(configured).verifyPan({ pan: 'ABCPV1234D', name: 'Asha Rao' });
    expect(out).toMatchObject({ verified: true, referenceId: '7' });
    expect(fetchFn.mock.calls[0][0]).toBe('https://sandbox.cashfree.com/verification/pan');
    expect(fetchFn.mock.calls[0][1].headers['x-client-id']).toBe('id');
  });

  it('rejects a PAN whose name does not match', async () => {
    mockFetch(200, { valid: true, name_match_result: 'NO_MATCH' });
    const out = await build(configured).verifyPan({ pan: 'ABCPV1234D', name: 'Someone Else' });
    expect(out.verified).toBe(false);
  });

  it('turns a Cashfree 422 about the input into a rejection, not an error', async () => {
    mockFetch(422, { code: 'ifsc_value_invalid', message: 'Invalid IFSC' });
    const out = await build(configured).verifyBankAccount({ accountNumber: '123456', ifsc: 'BAD', name: 'X Y' });
    expect(out).toEqual({ verified: false, reason: 'Invalid IFSC' });
  });

  it('surfaces auth failures as 503, not as a user rejection', async () => {
    mockFetch(401, { code: 'authentication_failed', message: 'bad creds' });
    await expect(build(configured).verifyBankAccount({ accountNumber: '123456', ifsc: 'HDFC0000001', name: 'X Y' })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('accepts a bank account only when valid and the name matches', async () => {
    mockFetch(200, { account_status: 'VALID', name_at_bank: 'ASHA RAO', bank_name: 'HDFC', name_match_result: 'GOOD_PARTIAL_MATCH', reference_id: 9 });
    const out = await build(configured).verifyBankAccount({ accountNumber: '123456', ifsc: 'HDFC0000001', name: 'Asha Rao' });
    expect(out).toMatchObject({ verified: true, bankName: 'HDFC', nameAtBank: 'ASHA RAO' });
  });

  it('sends UPI penny-drop with consent and the api version header', async () => {
    const fetchFn = mockFetch(200, { status: 'VALID', name_at_bank: 'ASHA RAO', reference_id: 3 });
    const out = await build(configured).verifyUpi({ vpa: 'asha@okhdfc', name: 'Asha Rao', verificationId: 'upi-1' });
    expect(out.verified).toBe(true);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://sandbox.cashfree.com/verification/upi/penny-drop');
    expect(init.headers['x-api-version']).toBe('2024-12-01');
    expect(JSON.parse(init.body).user_consent).toMatchObject({ obtained: true, type: 'EXPLICIT' });
  });
});
