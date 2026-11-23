import * as dns from 'node:dns';
import * as https from 'node:https';
import * as net from 'node:net';

export const FETCH_TIMEOUT_MS = 5000;
export const MAX_BODY_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;

export class UnsafeUrlError extends Error {}

const v4Private = (a: number, b: number): boolean =>
  a === 0 ||
  a === 10 ||
  a === 127 ||
  a >= 224 ||
  (a === 100 && b >= 64 && b <= 127) ||
  (a === 169 && b === 254) ||
  (a === 172 && b >= 16 && b <= 31) ||
  (a === 192 && b === 168) ||
  (a === 192 && b === 0) ||
  (a === 198 && (b === 18 || b === 19));

/** Expands an IPv6 literal (already validated by net.isIP) into eight 16-bit groups; handles '::' and a dotted IPv4 tail. */
const expandIpv6 = (ip: string): number[] | null => {
  let text = ip;
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number);
    text = text.slice(0, tail.index) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const [head, rest] = text.split('::');
  const headGroups = head ? head.split(':') : [];
  const restGroups = rest === undefined ? [] : rest ? rest.split(':') : [];
  const fill = 8 - headGroups.length - restGroups.length;
  if (rest === undefined ? headGroups.length !== 8 : fill < 0) return null;
  const all = [...headGroups, ...Array<string>(rest === undefined ? 0 : fill).fill('0'), ...restGroups];
  const nums = all.map((g) => parseInt(g, 16));
  return nums.length === 8 && nums.every((n) => Number.isFinite(n)) ? nums : null;
};

export const isPrivateIp = (ip: string): boolean => {
  const bare = ip.replace(/^\[|\]$/g, '').split('%')[0];
  const family = net.isIP(bare);
  if (family === 4) {
    const [a, b] = bare.split('.').map(Number);
    return v4Private(a, b);
  }
  if (family === 6) {
    const lower = bare.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    const dotted = /^::ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(lower);
    if (dotted) return v4Private(Number(dotted[1]), Number(dotted[2]));
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
    if (hex) return v4Private(parseInt(hex[1], 16) >> 8, parseInt(hex[1], 16) & 0xff);
    const groups = expandIpv6(lower);
    if (!groups) return true;
    const first = groups[0];
    const upper96Zero = groups.slice(0, 6).every((g) => g === 0);
    // IPv4-compatible ::a.b.c.d / ::hhhh:hhhh (first 96 bits zero): judge the embedded IPv4.
    if (upper96Zero) return v4Private(groups[6] >> 8, groups[6] & 0xff);
    // NAT64 64:ff9b::/96 embeds an IPv4; 64:ff9b:1::/48 is local-use.
    if (groups[0] === 0x64 && groups[1] === 0xff9b) {
      if (groups[2] === 1) return true;
      if (groups.slice(2, 6).every((g) => g === 0)) return v4Private(groups[6] >> 8, groups[6] & 0xff);
    }
    // fec0::/10 site-local
    if ((first & 0xffc0) === 0xfec0) return true;
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
  }
  return true; // not an IP at all: refuse
};

/** Static checks only (scheme, credentials, port, IP-literal host). DNS is re-checked at connect time. */
export const assertSafeImportUrl = (raw: string): URL => {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UnsafeUrlError('That is not a valid URL.');
  }
  if (url.protocol !== 'https:') throw new UnsafeUrlError('Only https:// calendar links are allowed.');
  if (url.username || url.password) throw new UnsafeUrlError('Links with embedded credentials are not allowed.');
  if (url.port && url.port !== '443') throw new UnsafeUrlError('Only the default https port is allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isPrivateIp(host)) throw new UnsafeUrlError('That address is not allowed.');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new UnsafeUrlError('That address is not allowed.');
  }
  return url;
};

/** DNS lookup that refuses private results, so the check holds at the moment of connecting (no rebinding gap). */
const guardedLookup: typeof dns.lookup = ((hostname: string, options: any, callback: any) => {
  const cb = typeof options === 'function' ? options : callback;
  const opts = typeof options === 'function' ? {} : options;
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return cb(err);
    const list = addresses as unknown as dns.LookupAddress[];
    if (list.length === 0 || list.some((a) => isPrivateIp(a.address))) {
      return cb(new UnsafeUrlError('That address is not allowed.'));
    }
    if (opts?.all) return cb(null, list);
    return cb(null, list[0].address, list[0].family);
  });
}) as typeof dns.lookup;

const getOnce = (url: URL): Promise<{ status: number; location?: string; body: string }> =>
  new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { lookup: guardedLookup, timeout: FETCH_TIMEOUT_MS, headers: { Accept: 'text/calendar, text/plain, */*', 'User-Agent': 'RhenBasera-CalendarSync/1.0' } },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, location: res.headers.location, body: '' });
        }
        const declared = Number(res.headers['content-length']);
        if (declared > MAX_BODY_BYTES) {
          req.destroy();
          return reject(new Error('Calendar file is larger than 1 MB.'));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            req.destroy();
            return reject(new Error('Calendar file is larger than 1 MB.'));
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('Calendar server took too long to respond.')));
    req.on('error', reject);
  });

export const fetchCalendarText = async (rawUrl: string): Promise<string> => {
  let url = assertSafeImportUrl(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await getOnce(url);
    if (res.status >= 300 && res.status < 400) {
      if (!res.location) throw new Error('Calendar server sent a bad redirect.');
      url = assertSafeImportUrl(new URL(res.location, url).toString());
      continue;
    }
    if (res.status !== 200) throw new Error(`Calendar server answered with HTTP ${res.status}.`);
    return res.body;
  }
  throw new Error('Calendar link redirected too many times.');
};
