import { buildSparql, parseBindings } from './wikidata-source';
import {
  attractionInputSchema,
  nearestDistrict,
  resolveDistrict,
  slugify,
  summarise,
  uniqueSlug,
  youtubeIdFrom,
} from './attraction.util';
import { commonsFileTitle } from './external-sources';
import { HP_DISTRICTS } from '../listings/hp-locations';
import { DISTRICT_SEARCH_RADIUS_M } from './attraction.util';

describe('resolveDistrict', () => {
  it('takes an explicit district, case-insensitively', () => {
    expect(resolveDistrict({ district: 'kullu' })).toBe('Kullu');
  });
  it('maps a tehsil to its district', () => {
    expect(resolveDistrict({ tehsil: 'Manali' })).toBe('Kullu');
  });
  it('maps free text naming a tourist place', () => {
    expect(resolveDistrict({ q: 'Kasol' })).toBe('Kullu');
    expect(resolveDistrict({ q: 'McLeodganj' })).toBe('Kangra');
  });
  it('maps free text naming a district', () => {
    expect(resolveDistrict({ q: 'shimla' })).toBe('Shimla');
  });
  it('is null for a search not about one district', () => {
    expect(resolveDistrict({})).toBeNull();
    expect(resolveDistrict({ q: 'wifi cabin' })).toBeNull();
    expect(resolveDistrict({ district: 'Atlantis' })).toBeNull();
  });
  it('takes the first of a repeated param', () => {
    expect(resolveDistrict({ district: ['Mandi', 'Una'] })).toBe('Mandi');
  });
});

describe('nearestDistrict', () => {
  it('files a point under the nearest district centre', () => {
    expect(nearestDistrict(32.24, 77.19)).toBe('Kullu');
    expect(nearestDistrict(31.1, 77.17)).toBe('Shimla');
  });
  it('has a search radius for every district', () => {
    for (const d of HP_DISTRICTS)
      expect(DISTRICT_SEARCH_RADIUS_M[d]).toBeGreaterThan(0);
  });
});

describe('slugs', () => {
  it('slugifies names', () => {
    expect(slugify('Hadimba Devi Temple')).toBe('hadimba-devi-temple');
    expect(slugify('  ')).toBe('place');
  });
  it('avoids taken slugs', () => {
    const taken = new Set(['jogini-falls', 'jogini-falls-kullu']);
    expect(uniqueSlug('Jogini Falls', 'Kullu', taken)).toBe('jogini-falls-2');
    expect(uniqueSlug('Jogini Falls', 'Mandi', new Set(['jogini-falls']))).toBe(
      'jogini-falls-mandi',
    );
  });
});

describe('summarise', () => {
  it('keeps short text and trims long text at a sentence', () => {
    expect(summarise('Short.')).toBe('Short.');
    const long = 'A'.repeat(80) + '. ' + 'B'.repeat(200);
    expect(summarise(long)).toBe('A'.repeat(80) + '.');
    expect(summarise(null)).toBeNull();
  });
});

describe('youtubeIdFrom', () => {
  it('reads ids and common URLs', () => {
    expect(youtubeIdFrom('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(
      youtubeIdFrom('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3'),
    ).toBe('dQw4w9WgXcQ');
    expect(youtubeIdFrom('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(youtubeIdFrom('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe(
      'dQw4w9WgXcQ',
    );
    expect(youtubeIdFrom('not a video')).toBeNull();
  });
});

describe('commonsFileTitle', () => {
  it('reads names, page URLs and upload URLs', () => {
    expect(commonsFileTitle('Hadimba Temple.jpg')).toBe(
      'File:Hadimba Temple.jpg',
    );
    expect(
      commonsFileTitle(
        'https://commons.wikimedia.org/wiki/File:Hadimba_Temple.jpg',
      ),
    ).toBe('File:Hadimba Temple.jpg');
    expect(
      commonsFileTitle(
        'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Hadimba_Temple.jpg/800px-Hadimba_Temple.jpg',
      ),
    ).toBe('File:Hadimba Temple.jpg');
    expect(commonsFileTitle('')).toBeNull();
  });
});

describe('attractionInputSchema', () => {
  const base = {
    name: 'Kheerganga',
    category: 'trek',
    district: 'Kullu',
    lat: 32.0,
    lng: 77.5,
  };
  it('accepts a trek and normalises video links', () => {
    const r = attractionInputSchema.parse({
      ...base,
      difficulty: 'moderate',
      youtubeIds: ['https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
      tehsil: '',
    });
    expect(r.youtubeIds).toEqual(['dQw4w9WgXcQ']);
    expect(r.tehsil).toBeNull();
  });
  it('rejects a point outside Himachal and a bad video', () => {
    expect(
      attractionInputSchema.safeParse({ ...base, lat: 28.6 }).success,
    ).toBe(false);
    expect(
      attractionInputSchema.safeParse({ ...base, youtubeIds: ['nope'] })
        .success,
    ).toBe(false);
  });
});

describe('Wikidata source', () => {
  const row = (
    qid: string,
    label: string,
    type: string,
    extra: Record<string, string> = {},
  ) => ({
    item: { value: `http://www.wikidata.org/entity/${qid}` },
    itemLabel: { value: label },
    type: { value: `http://www.wikidata.org/entity/${type}` },
    coord: { value: extra.coord ?? 'Point(77.1806 32.2486)' },
    article: {
      value: `https://en.wikipedia.org/wiki/${label.replace(/ /g, '_')}`,
    },
    links: { value: extra.links ?? '12' },
    ...(extra.image ? { image: { value: extra.image } } : {}),
  });

  it('asks for the classes we show around a point', () => {
    const q = buildSparql(32.2, 77.1, 45);
    expect(q).toContain('"Point(77.10000 32.20000)"^^geo:wktLiteral');
    expect(q).toContain('wikibase:radius "45"');
    expect(q).toContain('wd:Q34038');
    expect(q).toContain('schema:isPartOf <https://en.wikipedia.org/>');
  });

  it('merges an item matched by several classes and takes the higher-priority category', () => {
    const places = parseBindings([
      row('Q1', 'Hadimba Devi Temple', 'Q570116'),
      row('Q1', 'Hadimba Devi Temple', 'Q842402', {
        image: 'http://commons.wikimedia.org/wiki/Special:FilePath/Hadimba.jpg',
      }),
    ]);
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({
      qid: 'Q1',
      category: 'temple',
      articleTitle: 'Hadimba Devi Temple',
      languages: 12,
    });
    expect(places[0].commonsImage).toContain('Hadimba.jpg');
    expect(places[0].popularity).toBe(35 + 12 * 3);
  });

  it('drops unlabeled items and merges near-duplicate items, keeping the better documented', () => {
    const places = parseBindings([
      row('Q2', 'Q99999', 'Q23397'),
      row('Q3', 'Bhrigu Lake', 'Q23397', {
        links: '6',
        coord: 'Point(77.1 32.3)',
      }),
      row('Q4', 'Brighu Lake', 'Q23397', {
        links: '2',
        coord: 'Point(77.1001 32.3001)',
      }),
      row('Q5', 'Dashair Lake', 'Q23397', {
        links: '1',
        coord: 'Point(77.5 32.0)',
      }),
    ]);
    expect(places.map((p) => p.name).sort()).toEqual([
      'Bhrigu Lake',
      'Dashair Lake',
    ]);
  });

  it('ignores classes we do not show', () => {
    expect(parseBindings([row('Q6', 'Some Bank', 'Q22687')])).toHaveLength(0);
  });
});
