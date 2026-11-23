import { assertSafeImportUrl, isPrivateIp } from './safe-fetch.util';

describe('safe-fetch.util', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1'])(
    'flags %s as private',
    (ip) => expect(isPrivateIp(ip)).toBe(true),
  );

  it.each(['8.8.8.8', '172.32.0.1', '2606:4700:4700::1111'])('allows public %s', (ip) => expect(isPrivateIp(ip)).toBe(false));

  it.each([
    '64:ff9b::7f00:1',
    '64:ff9b::10.0.0.1',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b:1::1',
    '64:ff9b:1:abcd::1',
    'fec0::1',
    'feff::1',
    '::127.0.0.1',
    '::7f00:1',
    '::10.1.2.3',
    '::',
    '::1',
  ])('flags special IPv6 %s as private', (ip) => expect(isPrivateIp(ip)).toBe(true));

  it.each(['64:ff9b::808:808', '::8.8.8.8', '2001:db8::1'])('allows %s', (ip) => expect(isPrivateIp(ip)).toBe(false));

  it('accepts a plain https URL', () => {
    expect(assertSafeImportUrl('https://example.com/cal.ics').hostname).toBe('example.com');
  });

  it.each(['http://example.com/a.ics', 'https://localhost/a', 'https://127.0.0.1/a', 'https://[::1]/a', 'https://u:p@example.com/a', 'https://example.com:8443/a', 'nonsense'])(
    'rejects %s',
    (u) => expect(() => assertSafeImportUrl(u)).toThrow(),
  );
});
