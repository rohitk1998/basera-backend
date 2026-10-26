import request from 'supertest';
import { Client } from 'pg';
import { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthGuard } from '../src/auth/auth.guard';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { ResponseMessageInterceptor } from '../src/common/interceptors/response-message.interceptor';
import * as entities from '../src/entities';
import { BookingEntity, ListingEntity, UserEntity } from '../src/entities';
import { ListingTranslationService } from '../src/listings/listing-translation.service';
import { ListingsController } from '../src/listings/listings.controller';
import { ListingsService } from '../src/listings/listings.service';
import { RedisService } from '../src/redis/redis.service';

const SCHEMA = 'listing_search_e2e';
const host = process.env.SUPABASE_DB_HOST ?? '';
const isLocal = ['127.0.0.1', 'localhost', '::1'].includes(host);
const describeLocal = isLocal ? describe : describe.skip;

type Fixture = {
  key: string;
  status?: string;
  created: string;
  pd: Record<string, unknown>;
  trust?: number;
};

const FIXTURES: Fixture[] = [
  {
    key: 'pine',
    created: '2026-09-01T10:00:00Z',
    trust: 90,
    pd: {
      title: 'Pine View Cottage', town: 'Kasol', tehsil: 'Bhuntar', district: 'Kullu',
      categories: ['work', 'views'], dailyBaseRate: 1000, monthlyDiscountPct: 40, maxGuests: 4,
    },
  },
  {
    key: 'river',
    created: '2026-09-02T10:00:00Z',
    trust: 70,
    pd: {
      title: 'Riverside Stay', town: 'Manali', tehsil: 'Manali', district: 'Kullu',
      categories: ['quiet'], dailyBaseRate: 1500, monthlyDiscountPct: 20, maxGuests: 2,
    },
  },
  {
    key: 'kabir',
    created: '2026-09-03T10:00:00Z',
    pd: {
      title: 'Kabir Villa', town: 'Dharamshala', tehsil: 'Dharamshala', district: 'Kangra',
      categories: ['work'], dailyBaseRate: 800, monthlyDiscountPct: 40,
    },
  },
  {
    key: 'bir',
    created: '2026-09-04T10:00:00Z',
    pd: {
      title: 'Bir Billing Retreat', town: 'Bir', tehsil: 'Baijnath', district: 'Kangra',
      categories: ['work', 'long'], dailyBaseRate: 900, monthlyDiscountPct: 40,
    },
  },
  {
    key: 'spiti',
    created: '2026-09-05T10:00:00Z',
    pd: {
      title: 'Spiti Homestay', town: 'Kaza', tehsil: 'Kaza', district: 'Lahaul and Spiti',
      dailyBaseRate: 700, monthlyDiscountPct: 40,
    },
  },
  {
    key: 'orphan',
    created: '2026-09-06T10:00:00Z',
    pd: { title: 'Orphan Nook', town: 'Somewhere', categories: ['work'], dailyBaseRate: 500 },
  },
  {
    key: 'hidden',
    status: 'in_review',
    created: '2026-09-07T10:00:00Z',
    pd: { title: 'Hidden Kasol Room', town: 'Kasol', tehsil: 'Bhuntar', district: 'Kullu', categories: ['work'] },
  },
  {
    key: 'wild',
    created: '2026-09-08T10:00:00Z',
    pd: { title: '100% Real_Deal', town: 'Karsog', tehsil: 'Karsog', district: 'Mandi', categories: ['long'], dailyBaseRate: 600 },
  },
  {
    key: 'case',
    created: '2026-09-09T10:00:00Z',
    pd: {
      title: 'Case Cabin', town: 'Bhuntar', tehsil: 'bhuntar', district: 'KULLU',
      dailyBaseRate: 2000, monthlyDiscountPct: 40,
    },
  },
];

describeLocal('GET /api/listings (real SQL)', () => {
  let app: INestApplication;
  let ds: DataSource;
  const ids: Record<string, string> = {};
  const idToKey: Record<string, string> = {};

  const scratchOptions = `-c search_path=${SCHEMA},public`;
  const connection = () => ({
    host,
    port: Number(process.env.SUPABASE_DB_PORT),
    user: process.env.SUPABASE_DB_USER,
    password: process.env.SUPABASE_DB_PASSWORD,
    database: process.env.SUPABASE_DB_NAME,
  });

  beforeAll(async () => {
    const admin = new Client(connection());
    await admin.connect();
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await admin.query(`CREATE SCHEMA ${SCHEMA}`);
      await admin.query(`CREATE TABLE ${SCHEMA}.listings (LIKE public.listings INCLUDING DEFAULTS)`);
      await admin.query(`CREATE TABLE ${SCHEMA}.bookings (LIKE public.bookings INCLUDING DEFAULTS)`);
      for (const f of FIXTURES) {
        const draft: Record<string, unknown> = { property_details: f.pd };
        if (f.trust !== undefined) draft.trustScore = f.trust;
        const res = await admin.query(
          `INSERT INTO ${SCHEMA}.listings (host_id, status, draft_data, created_at)
           VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`,
          [f.status ?? 'live', JSON.stringify(draft), f.created],
        );
        ids[f.key] = res.rows[0].id;
        idToKey[res.rows[0].id] = f.key;
      }
    } finally {
      await admin.end();
    }

    ds = new DataSource({
      type: 'postgres',
      ...connection(),
      username: connection().user,
      ssl: false,
      entities: Object.values(entities),
      synchronize: false,
      extra: { options: scratchOptions },
    });
    await ds.initialize();

    const store = new Map<string, string>();
    const moduleRef = await Test.createTestingModule({
      controllers: [ListingsController],
      providers: [
        ListingsService,
        { provide: APP_INTERCEPTOR, useClass: ResponseMessageInterceptor },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
        { provide: getRepositoryToken(ListingEntity), useValue: ds.getRepository(ListingEntity) },
        { provide: getRepositoryToken(UserEntity), useValue: ds.getRepository(UserEntity) },
        { provide: getRepositoryToken(BookingEntity), useValue: ds.getRepository(BookingEntity) },
        { provide: ListingTranslationService, useValue: { getCachedTranslationsBatch: async () => new Map(), warmTranslation: () => {} } },
        {
          provide: RedisService,
          useValue: {
            get: async (k: string) => store.get(k) ?? null,
            set: async (k: string, v: string) => (store.set(k, v), true),
            getVersion: async () => '1',
          },
        },
        { provide: AuthGuard, useValue: { verify: () => { throw new Error('no session'); } } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await ds?.destroy();
    const admin = new Client(connection());
    await admin.connect();
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    } finally {
      await admin.end();
    }
  });

  const get = (qs: string) => request(app.getHttpServer()).get(`/api/listings${qs}`);
  const keys = (body: { listings: { id: string }[] }) => body.listings.map((l) => idToKey[l.id]);
  const sorted = (a: string[]) => [...a].sort((x, y) => x.localeCompare(y));

  describe('q (free text)', () => {
    it('finds a listing by its property title', async () => {
      const res = await get('?q=pine').expect(200);
      expect(keys(res.body)).toEqual(['pine']);
      expect(res.body).toMatchObject({ success: true, total: 1, page: 1, pageSize: 48 });
    });

    it('needs every word to match (AND), in any order', async () => {
      expect(keys((await get('?q=cottage%20pine')).body)).toEqual(['pine']);
      expect((await get('?q=pine%20kabir')).body.listings).toEqual([]);
    });

    it('matches a word in the middle of a title, and case-insensitively', async () => {
      expect(keys((await get('?q=BILLING')).body)).toEqual(['bir']);
    });

    it('finds listings by tehsil', async () => {
      expect(sorted(keys((await get('?q=baijnath')).body))).toEqual(['bir']);
      expect(sorted(keys((await get('?q=Bhuntar')).body))).toEqual(['case', 'pine']);
    });

    it('finds listings by district, including a differently-capitalised stored value', async () => {
      expect(sorted(keys((await get('?q=kangra')).body))).toEqual(['bir', 'kabir']);
      expect(sorted(keys((await get('?q=kullu')).body))).toEqual(['case', 'pine', 'river']);
      expect(keys((await get('?q=lahaul')).body)).toEqual(['spiti']);
    });

    it('finds a legacy listing that only has a town', async () => {
      expect(keys((await get('?q=somewhere')).body)).toEqual(['orphan']);
    });

    it('never returns a non-live listing', async () => {
      const res = await get('?q=hidden').expect(200);
      expect(res.body.listings).toEqual([]);
      expect(sorted(keys((await get('?q=kasol')).body))).not.toContain('hidden');
    });

    it('expands a tourist name through the alias map: Kasol also finds the Bhuntar tehsil, Kullu district', async () => {
      expect(sorted(keys((await get('?q=Kasol')).body))).toEqual(['case', 'pine']);
      expect(sorted(keys((await get('?q=kasol%20cottage')).body))).toEqual(['pine']);
    });

    it('expands a multi-word alias: Spiti Valley finds the Kaza listing', async () => {
      expect(keys((await get('?q=Spiti%20Valley')).body)).toEqual(['spiti']);
    });

    it('keeps the old town and location params working as aliases of q', async () => {
      const q = keys((await get('?q=Kasol')).body);
      expect(keys((await get('?town=Kasol')).body)).toEqual(q);
      expect(keys((await get('?location=Kasol')).body)).toEqual(q);
    });

    it('matches word starts only: "bir" finds Bir but not Kabir', async () => {
      expect(keys((await get('?q=bir')).body)).toEqual(['bir']);
      expect(keys((await get('?q=abir')).body)).toEqual([]);
      expect(keys((await get('?q=ir')).body)).toEqual([]);
      expect(sorted(keys((await get('?q=kabir')).body))).toEqual(['kabir']);
    });

    it('treats %, _ and backslash as literal characters', async () => {
      expect((await get('?q=%25')).body.listings).toEqual([]);
      expect((await get('?q=_')).body.listings).toEqual([]);
      expect((await get('?q=%5C')).body.listings).toEqual([]);
      expect((await get('?q=rea_')).body.listings).toEqual([]);
      expect(keys((await get('?q=real_')).body)).toEqual(['wild']);
      expect(keys((await get('?q=100%25')).body)).toEqual(['wild']);
    });

    it('does not search the description', async () => {
      await ds.query(
        `UPDATE ${SCHEMA}.listings SET draft_data = jsonb_set(draft_data, '{property_details,description}', '"close to the zebracrossing"') WHERE id = $1`,
        [ids.pine],
      );
      expect((await get('?q=zebracrossing')).body.listings).toEqual([]);
    });

    it('returns everything for an empty or blank q', async () => {
      expect((await get('?q=')).body.total).toBe(8);
      expect((await get('?q=%20%20')).body.total).toBe(8);
    });
  });

  describe('filters', () => {
    it('combines q and category with AND', async () => {
      expect(keys((await get('?q=kasol&category=work')).body)).toEqual(['pine']);
      expect((await get('?q=kasol&category=quiet')).body.listings).toEqual([]);
      expect(sorted(keys((await get('?q=kangra&category=long')).body))).toEqual(['bir']);
    });

    it('combines district and category with AND', async () => {
      expect(sorted(keys((await get('?district=Kangra&category=work')).body))).toEqual(['bir', 'kabir']);
      expect(keys((await get('?district=kullu&category=quiet')).body)).toEqual(['river']);
      expect((await get('?district=Mandi&category=quiet')).body.listings).toEqual([]);
    });

    it('filters district exactly and case-insensitively (not by substring)', async () => {
      expect(sorted(keys((await get('?district=kullu')).body))).toEqual(['case', 'pine', 'river']);
      expect((await get('?district=Kul')).body.total).toBe(8);
      expect(keys((await get('?district=Lahaul%20and%20Spiti')).body)).toEqual(['spiti']);
    });

    it('filters tehsil exactly and case-insensitively', async () => {
      expect(sorted(keys((await get('?tehsil=BHUNTAR')).body))).toEqual(['case', 'pine']);
      expect((await get('?tehsil=Bhunt')).body.listings).toEqual([]);
      expect(keys((await get('?district=Kullu&tehsil=Manali')).body)).toEqual(['river']);
      expect((await get('?district=Kangra&tehsil=Manali')).body.listings).toEqual([]);
    });

    it('does not offer a listing a category the host never stored', async () => {
      const res = await get('?q=spiti').expect(200);
      expect(res.body.listings[0].categories).toEqual([]);
      for (const c of ['long', 'entire', 'work', 'views', 'quiet']) {
        expect(keys((await get(`?category=${c}`)).body)).not.toContain('spiti');
      }
    });

    it('ignores an invalid district or category instead of failing', async () => {
      expect((await get('?district=Narnia').expect(200)).body.total).toBe(8);
      expect((await get('?category=beach').expect(200)).body.total).toBe(8);
      expect((await get("?district=Kullu';drop%20table%20listings;--").expect(200)).body.total).toBe(8);
    });

    it('filters by guests', async () => {
      expect(sorted(keys((await get('?guests=3')).body))).toEqual(['pine']);
      expect((await get('?guests=2')).body.total).toBe(8);
      expect((await get('?guests=abc')).body.total).toBe(8);
    });

    it('survives an impossible date instead of a 500', async () => {
      expect((await get('?date=2026-02-31').expect(200)).body.total).toBe(8);
    });
  });

  describe('robustness', () => {
    it('does not 500 on a repeated q (?q=a&q=b) and uses the first value', async () => {
      const res = await get('?q=kasol&q=bir').expect(200);
      expect(sorted(keys(res.body))).toEqual(sorted(keys((await get('?q=kasol')).body)));
    });

    it('does not 500 on other repeated params', async () => {
      await get('?district=Kullu&district=Mandi&category=work&category=quiet&page=2&page=3&pageSize=5&pageSize=7&facets=1&facets=0').expect(200);
      await get('?q[a]=1').expect(200);
    });

    it('caps an overlong q', async () => {
      await get(`?q=${'a'.repeat(5000)}`).expect(200);
    });
  });

  describe('pagination', () => {
    it('is bounded by default and reports page and pageSize', async () => {
      const res = await get('').expect(200);
      expect(res.body).toMatchObject({ total: 8, page: 1, pageSize: 48 });
      expect(res.body.listings).toHaveLength(8);
    });

    it('pages with a stable newest-first order and the true total on every page', async () => {
      const p1 = (await get('?pageSize=3&page=1')).body;
      const p2 = (await get('?pageSize=3&page=2')).body;
      const p3 = (await get('?pageSize=3&page=3')).body;
      const p4 = (await get('?pageSize=3&page=4')).body;
      expect([p1.total, p2.total, p3.total, p4.total]).toEqual([8, 8, 8, 8]);
      expect([...keys(p1), ...keys(p2), ...keys(p3)]).toEqual(['case', 'wild', 'orphan', 'spiti', 'bir', 'kabir', 'river', 'pine']);
      expect(p4.listings).toEqual([]);
      expect(p2.page).toBe(2);
    });

    it('clamps nonsense: page >= 1, pageSize in 1..200, junk falls back to the defaults', async () => {
      expect((await get('?page=0')).body).toMatchObject({ page: 1, pageSize: 48 });
      expect((await get('?page=-4&pageSize=-1')).body).toMatchObject({ page: 1, pageSize: 48 });
      expect((await get('?page=abc&pageSize=xyz')).body).toMatchObject({ page: 1, pageSize: 48 });
      expect((await get('?pageSize=0')).body.pageSize).toBe(48);
      expect((await get('?pageSize=99999')).body.pageSize).toBe(200);
      expect((await get('?pageSize=1')).body.listings).toHaveLength(1);
      await get('?page=99999999999999999999').expect(200);
    });

    it('sorts by trust with unscored listings last', async () => {
      const order = keys((await get('?sort=trust')).body);
      expect(order.slice(0, 2)).toEqual(['pine', 'river']);
      expect(order).toHaveLength(8);
      expect(order.slice(2)).toEqual(['case', 'wild', 'orphan', 'spiti', 'bir', 'kabir']);
    });
  });

  describe('facets', () => {
    it('are absent unless asked for', async () => {
      expect((await get('')).body.facets).toBeUndefined();
      expect((await get('?facets=0')).body.facets).toBeUndefined();
    });

    it('count live listings per district (case-merged, no-district omitted but still in total)', async () => {
      const res = await get('?facets=1').expect(200);
      expect(res.body.total).toBe(8);
      expect(res.body.facets.districts).toEqual([
        { name: 'Kullu', count: 3 },
        { name: 'Kangra', count: 2 },
        { name: 'Lahaul and Spiti', count: 1 },
        { name: 'Mandi', count: 1 },
      ]);
    });

    it('list places with their district, count and cheapest monthly rent, biggest first', async () => {
      const { places } = (await get('?facets=1')).body.facets;
      expect(places[0]).toEqual({ district: 'Kullu', tehsil: 'Bhuntar', count: 2, fromMonthlyRent: 18000 });
      expect(places.slice(1).map((p: any) => p.tehsil)).toEqual(['Baijnath', 'Dharamshala', 'Karsog', 'Kaza', 'Manali', 'Somewhere']);
      expect(places.find((p: any) => p.tehsil === 'Manali')).toEqual({
        district: 'Kullu', tehsil: 'Manali', count: 1, fromMonthlyRent: 36000,
      });
      expect(places.find((p: any) => p.tehsil === 'Somewhere')).toEqual({
        district: '', tehsil: 'Somewhere', count: 1, fromMonthlyRent: 9000,
      });
      expect(places.find((p: any) => p.tehsil === 'Karsog')).toMatchObject({ district: 'Mandi', fromMonthlyRent: 10800 });
    });

    it('the districts facet ignores district and tehsil but honours everything else', async () => {
      const res = await get('?facets=1&district=Kangra&tehsil=Baijnath&category=work').expect(200);
      expect(keys(res.body)).toEqual(['bir']);
      expect(res.body.facets.districts).toEqual([
        { name: 'Kangra', count: 2 },
        { name: 'Kullu', count: 1 },
      ]);
    });

    it('the places facet honours district but ignores tehsil', async () => {
      const res = await get('?facets=1&district=Kangra&tehsil=Baijnath').expect(200);
      expect(keys(res.body)).toEqual(['bir']);
      expect(res.body.facets.places.map((p: any) => `${p.district}/${p.tehsil}/${p.count}`)).toEqual([
        'Kangra/Baijnath/1',
        'Kangra/Dharamshala/1',
      ]);
    });

    it('both facets honour q and category', async () => {
      const res = await get('?facets=1&q=kullu&category=quiet').expect(200);
      expect(keys(res.body)).toEqual(['river']);
      expect(res.body.facets.districts).toEqual([{ name: 'Kullu', count: 1 }]);
      expect(res.body.facets.places).toEqual([{ district: 'Kullu', tehsil: 'Manali', count: 1, fromMonthlyRent: 36000 }]);
    });

    it('are empty (not an error) when nothing matches', async () => {
      const res = await get('?facets=1&q=zzzz').expect(200);
      expect(res.body).toMatchObject({ total: 0, listings: [], facets: { districts: [], places: [] } });
    });

    it('count the whole filtered set, not just the page', async () => {
      const res = await get('?facets=1&pageSize=1').expect(200);
      expect(res.body.listings).toHaveLength(1);
      expect(res.body.facets.districts[0]).toEqual({ name: 'Kullu', count: 3 });
    });
  });

  describe('GET /api/listings/towns (deprecated wrapper)', () => {
    it('keeps its response shape, with the true total and a listings preview', async () => {
      const res = await request(app.getHttpServer()).get('/api/listings/towns').expect(200);
      expect(res.body.success).toBe(true);
      const towns = res.body.towns as { name: string; from: number; total: number; listings: { id: string; town: string }[] }[];
      expect(towns.map((t) => t.name)).toEqual(['Bhuntar', 'Baijnath', 'Dharamshala', 'Karsog', 'Kaza', 'Manali', 'Somewhere']);

      const bhuntar = towns[0];
      expect(bhuntar.total).toBe(2);
      expect(bhuntar.from).toBe(18000);
      expect(bhuntar.listings.map((l) => idToKey[l.id])).toEqual(['case', 'pine']);

      const { places } = (await get('?facets=1')).body.facets;
      expect(towns.map((t) => [t.name, t.total])).toEqual(places.map((p: any) => [p.tehsil, p.count]));
    });
  });

  describe('GET /api/listings/:id', () => {
    it('still serves a live listing', async () => {
      const res = await get(`/${ids.pine}`.replace('?', '')).expect(200);
      expect(res.body.listing.title).toBe('Pine View Cottage');
    });
  });
});
