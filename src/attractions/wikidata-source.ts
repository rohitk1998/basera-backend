import type { AttractionCategory } from './attraction.types';
import { USER_AGENT, getJson, getWithRetry } from './external-sources';

const TYPE_CATEGORY: ReadonlyArray<readonly [string, AttractionCategory]> = [
  ['Q842402', 'temple'],
  ['Q44539', 'temple'],
  ['Q5393308', 'temple'],
  ['Q44613', 'temple'],
  ['Q57821', 'fort'],
  ['Q23413', 'fort'],
  ['Q16560', 'fort'],
  ['Q33506', 'museum'],
  ['Q34038', 'waterfall'],
  ['Q23397', 'lake'],
  ['Q130003', 'adventure'],
  ['Q39816', 'viewpoint'],
  ['Q133056', 'viewpoint'],
  ['Q35666', 'viewpoint'],
  ['Q177380', 'viewpoint'],
  ['Q46169', 'viewpoint'],
  ['Q759421', 'viewpoint'],
  ['Q570116', 'viewpoint'],
];

export type WikiPlace = {
  qid: string;
  name: string;
  lat: number;
  lng: number;
  category: AttractionCategory;
  commonsImage: string | null;
  articleTitle: string;
  languages: number;
  popularity: number;
};

type Binding = Partial<
  Record<
    'item' | 'itemLabel' | 'type' | 'coord' | 'image' | 'article' | 'links',
    { value: string }
  >
>;

export function buildSparql(
  lat: number,
  lng: number,
  radiusKm: number,
): string {
  const types = TYPE_CATEGORY.map(([q]) => `wd:${q}`).join(' ');
  return `SELECT ?item ?itemLabel ?type ?coord ?image ?article ?links WHERE {
  SERVICE wikibase:around {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:center "Point(${lng.toFixed(5)} ${lat.toFixed(5)})"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "${radiusKm}" .
  }
  VALUES ?type { ${types} }
  ?item wdt:P31/wdt:P279* ?type .
  ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> .
  ?item wikibase:sitelinks ?links .
  OPTIONAL { ?item wdt:P18 ?image }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . }
}`;
}

const qidOf = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1);

function approxKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dx = (b.lng - a.lng) * Math.cos((a.lat * Math.PI) / 180) * 111.32;
  const dy = (b.lat - a.lat) * 110.57;
  return Math.hypot(dx, dy);
}

const normalise = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export function parseBindings(rows: Binding[]): WikiPlace[] {
  const byQid = new Map<string, WikiPlace & { rank: number }>();
  for (const row of rows) {
    const itemUri = row.item?.value;
    const name = row.itemLabel?.value?.trim();
    const article = row.article?.value;
    const coord = row.coord?.value.match(/^Point\((-?[\d.]+) (-?[\d.]+)\)$/);
    const typeQid = row.type ? qidOf(row.type.value) : '';
    const rank = TYPE_CATEGORY.findIndex(([q]) => q === typeQid);
    if (!itemUri || !name || !article || !coord || rank < 0) continue;
    const qid = qidOf(itemUri);
    if (/^Q\d+$/.test(name)) continue;
    const prev = byQid.get(qid);
    if (prev && prev.rank <= rank) continue;
    const languages = Number.parseInt(row.links?.value ?? '1', 10) || 1;
    byQid.set(qid, {
      qid,
      name,
      lng: Number(coord[1]),
      lat: Number(coord[2]),
      category: TYPE_CATEGORY[rank][1],
      commonsImage: row.image?.value ?? prev?.commonsImage ?? null,
      articleTitle: decodeURIComponent(
        article.slice(article.lastIndexOf('/wiki/') + 6),
      ).replace(/_/g, ' '),
      languages,
      popularity: Math.min(100, 35 + languages * 3),
      rank,
    });
  }

  const kept: WikiPlace[] = [];
  const sorted = [...byQid.values()].sort((a, b) => b.languages - a.languages);
  for (const place of sorted) {
    const twin = kept.find(
      (k) =>
        k.category === place.category &&
        (approxKm(k, place) < 0.3 ||
          (normalise(k.name) === normalise(place.name) &&
            approxKm(k, place) < 3)),
    );
    if (!twin) {
      const { rank: _rank, ...rest } = place as WikiPlace & { rank?: number };
      void _rank;
      kept.push(rest);
    } else if (!twin.commonsImage && place.commonsImage) {
      twin.commonsImage = place.commonsImage;
    }
  }
  return kept;
}

export async function fetchWikidataPlaces(
  lat: number,
  lng: number,
  radiusKm: number,
): Promise<WikiPlace[]> {
  const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(buildSparql(lat, lng, radiusKm))}`;
  const body = await getJson<{ results?: { bindings?: Binding[] } }>(url);
  return parseBindings(body.results?.bindings ?? []);
}

export type WikiSummary = {
  text: string;
  url: string;
  imageUrl: string | null;
};

export async function fetchWikipediaSummary(
  wikipediaTag: string,
): Promise<WikiSummary | null> {
  const m = wikipediaTag.match(/^en:(.+)$/);
  if (!m) return null;
  return summaryByTitle(m[1]);
}

export async function fetchWikipediaSummaryForQid(
  qid: string,
): Promise<WikiSummary | null> {
  if (!/^Q\d+$/.test(qid)) return null;
  const res = await fetch(
    `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=sitelinks&sitefilter=enwiki&format=json`,
    {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) return null;
  const body = (await res.json()) as {
    entities?: Record<string, { sitelinks?: { enwiki?: { title?: string } } }>;
  };
  const title = body.entities?.[qid]?.sitelinks?.enwiki?.title;
  return title ? summaryByTitle(title) : null;
}

export async function summaryByTitle(
  title: string,
): Promise<WikiSummary | null> {
  const res = await getWithRetry(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`,
  );
  if (!res.ok) return null;
  const body = (await res.json()) as {
    type?: string;
    extract?: string;
    content_urls?: { desktop?: { page?: string } };
    originalimage?: { source?: string };
  };
  if (body.type === 'disambiguation' || !body.extract) return null;
  return {
    text: body.extract,
    url:
      body.content_urls?.desktop?.page ??
      `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    imageUrl: body.originalimage?.source ?? null,
  };
}
