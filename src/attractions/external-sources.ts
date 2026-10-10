/**
 * Thin clients for the three outside sources the attractions feature uses.
 * Only the import job and the admin console call these — a guest request
 * never does, so an outage or rate limit here can never break search.
 *
 * Every call has a timeout. Rate limits (429) and server errors (5xx) are
 * retried with backoff; anything else fails that one call, and the caller
 * logs and moves on.
 */

const TIMEOUT_MS = 15_000;
const RETRIES = 3;
/** Wikimedia asks every client to identify itself. */
export const USER_AGENT =
  'BaseraBot/1.0 (https://basera.in; attractions import)';

export class SourceError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function getWithRetry(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** attempt);
    try {
      const res = await fetch(url, {
        ...init,
        headers: { 'User-Agent': USER_AGENT, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 429 || res.status >= 500) {
        lastError = new SourceError(`HTTP ${res.status}`, res.status);
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new SourceError(String(lastError));
}

export async function getJson<T>(url: string): Promise<T> {
  const res = await getWithRetry(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new SourceError(
      `HTTP ${res.status}: ${body.slice(0, 200)}`,
      res.status,
    );
  }
  return (await res.json()) as T;
}

// ------------------------------------------------------- Wikimedia Commons

/** Licenses we can show with a credit line. Anything else is skipped, not guessed at. */
const ALLOWED_LICENSE =
  /^(cc[- ]?by(-sa)?([- ]\d(\.\d)?)?|cc0|public domain|pd)/i;

export type CommonsImage = { url: string; credit: string };

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** "File:X.jpg" from a bare name, a "File:" title, a commons page URL or an upload.wikimedia.org URL. */
export function commonsFileTitle(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  try {
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      if (
        u.hostname === 'upload.wikimedia.org' ||
        u.hostname === 'thumb.wikimedia.org'
      ) {
        // .../commons/thumb/a/ab/Name.jpg/800px-Name.jpg or .../commons/a/ab/Name.jpg
        const parts = u.pathname.split('/');
        const thumbAt = parts.indexOf('thumb');
        s = thumbAt >= 0 ? parts[thumbAt + 3] : parts[parts.length - 1];
      } else {
        s = u.pathname.split('/').pop() ?? '';
      }
    }
    s = decodeURIComponent(s).replace(/_/g, ' ');
  } catch {
    return null;
  }
  s = s.replace(/^(file|image):/i, '').trim();
  return s ? `File:${s}` : null;
}

/** A ~1200px rendition of a Commons file plus its author/license line, or null when unusable. */
export async function fetchCommonsImage(
  fileTitle: string,
): Promise<CommonsImage | null> {
  const p = new URLSearchParams({
    action: 'query',
    titles: fileTitle,
    prop: 'imageinfo',
    iiprop: 'url|extmetadata|mime',
    iiurlwidth: '1200',
    format: 'json',
    origin: '*',
  });
  type Resp = {
    query?: {
      pages?: Record<
        string,
        {
          imageinfo?: Array<{
            thumburl?: string;
            url?: string;
            mime?: string;
            extmetadata?: Record<string, { value?: string }>;
          }>;
        }
      >;
    };
  };
  const body = await getJson<Resp>(
    `https://commons.wikimedia.org/w/api.php?${p}`,
  );
  const info = Object.values(body.query?.pages ?? {})[0]?.imageinfo?.[0];
  if (!info || !/^image\/(jpeg|png|webp)$/.test(info.mime ?? '')) return null;
  const meta = info.extmetadata ?? {};
  const license = stripHtml(meta.LicenseShortName?.value ?? '');
  if (!ALLOWED_LICENSE.test(license)) return null;
  const artist = stripHtml(meta.Artist?.value ?? '') || 'Unknown author';
  const url = info.thumburl ?? info.url;
  if (!url) return null;
  return { url, credit: `${artist}, ${license}, via Wikimedia Commons` };
}

/** The Commons file a Wikidata item names as its image (P18), or null. */
export async function wikidataImageTitle(qid: string): Promise<string | null> {
  if (!/^Q\d+$/.test(qid)) return null;
  type Resp = {
    claims?: { P18?: Array<{ mainsnak?: { datavalue?: { value?: string } } }> };
  };
  const body = await getJson<Resp>(
    `https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=${qid}&property=P18&format=json`,
  );
  const name = body.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
  return name ? `File:${name}` : null;
}

/** Downloads an image, refusing anything that is not a reasonably sized JPEG/PNG/WebP. */
export async function downloadImage(
  url: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  const res = await getWithRetry(url);
  if (!res.ok) return null;
  const contentType = (res.headers.get('content-type') ?? '')
    .split(';')[0]
    .trim();
  if (!/^image\/(jpeg|png|webp)$/.test(contentType)) return null;
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 2_000 || buffer.length > 8 * 1024 * 1024) return null;
  return { buffer, contentType };
}

// ----------------------------------------------------------------- YouTube

export type YoutubeVideo = {
  id: string;
  title: string;
  channel: string;
  thumbnail: string | null;
  publishedAt: string | null;
};

/**
 * Embeddable videos for a query. One search costs 100 of the free 10,000
 * daily quota units, so this is for the admin console only.
 */
export async function searchYoutube(
  apiKey: string,
  q: string,
): Promise<YoutubeVideo[]> {
  const p = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    videoEmbeddable: 'true',
    maxResults: '8',
    regionCode: 'IN',
    relevanceLanguage: 'en',
    q,
    key: apiKey,
  });
  type Resp = {
    items?: Array<{
      id?: { videoId?: string };
      snippet?: {
        title?: string;
        channelTitle?: string;
        publishedAt?: string;
        thumbnails?: { medium?: { url?: string }; default?: { url?: string } };
      };
    }>;
  };
  const body = await getJson<Resp>(
    `https://www.googleapis.com/youtube/v3/search?${p}`,
  );
  return (body.items ?? [])
    .filter((i) => i.id?.videoId)
    .map((i) => ({
      id: i.id!.videoId!,
      title: stripHtml(i.snippet?.title ?? ''),
      channel: i.snippet?.channelTitle ?? '',
      thumbnail:
        i.snippet?.thumbnails?.medium?.url ??
        i.snippet?.thumbnails?.default?.url ??
        null,
      publishedAt: i.snippet?.publishedAt ?? null,
    }));
}
