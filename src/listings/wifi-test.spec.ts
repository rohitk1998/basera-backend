import { BadRequestException } from '@nestjs/common';
import { HostListingsService } from './host-listings.service';
import {
  applyWifiAmenity,
  cappedMbps,
  serverMbps,
  WORK_CATEGORY_MESSAGE,
  wifiTestTokenKey,
} from './wifi-test.util';

describe('wifi-test.util: throughput', () => {
  it('adds parallel streams over the span from the first write to the last', () => {
    const mbps = serverMbps([
      { bytes: 5e6, firstAt: 1000, lastAt: 1900 },
      { bytes: 5e6, firstAt: 1100, lastAt: 2000 },
    ]);
    expect(mbps).toBeCloseTo(80);
  });

  it('has no figure without streams or a measurable span', () => {
    expect(serverMbps([])).toBeNull();
    expect(serverMbps([{ bytes: 1e6, firstAt: 5, lastAt: 5 }])).toBeNull();
  });

  it('keeps a client figure within 1.5x of the server, replaces one above it', () => {
    expect(cappedMbps(50, 40)).toBe(50);
    expect(cappedMbps(60, 40)).toBe(60);
    expect(cappedMbps(900, 40)).toBe(40);
    expect(cappedMbps(900, null)).toBe(0);
    expect(cappedMbps(Number.NaN, 40)).toBe(0);
  });
});

describe('wifi-test.util: Wifi amenity', () => {
  const measured = { downMbps: 30, upMbps: 10, pingMs: 20, jitterMs: 2, connectionType: null, testedAt: new Date().toISOString(), capture: { distanceFromPinM: 5, accuracyM: 10, capturedAt: new Date().toISOString() } };

  it('strips a client-sent Wifi when nothing was measured', () => {
    expect(applyWifiAmenity(['Wifi', 'Kitchen'], undefined)).toEqual(['Kitchen']);
    expect(applyWifiAmenity(['Wifi', 'Kitchen'], { answer: 'yes' })).toEqual(['Kitchen']);
  });

  it('adds Wifi for a measured result the host answered yes to, once', () => {
    expect(applyWifiAmenity(['Kitchen', 'Wifi'], { answer: 'yes', ...measured })).toEqual(['Wifi', 'Kitchen']);
    expect(applyWifiAmenity(['Kitchen'], { answer: 'later', ...measured })).toEqual(['Kitchen']);
    expect(applyWifiAmenity(['Kitchen'], { answer: 'no', ...measured })).toEqual(['Kitchen']);
  });
});

const PIN = { lat: 32.219, lng: 76.3234 };
const NOW = new Date().toISOString();
const TOKEN = '6b1f0c2e-3a4d-4e5f-8a9b-0c1d2e3f4a5b';

const record = (over: Record<string, unknown> = {}) => ({
  kind: 'photo',
  lat: PIN.lat,
  lng: PIN.lng,
  accuracyM: 10,
  capturedAt: NOW,
  receivedAt: NOW,
  distanceFromPinM: 0,
  source: 'device_reported',
  ...over,
});
const url = (n: number) => `https://s.test/u1/photos/${n}.jpg`;
const photoList = () => [1, 2, 3, 4, 5].map((n) => ({ url: url(n), room: 'living' }));

const body = (over: Record<string, unknown> = {}) => ({
  title: 'Pine view home',
  propertyType: 'house',
  placeType: 'entire',
  beds: '1BHK',
  bedrooms: 1,
  bathrooms: 1,
  maxGuests: 2,
  district: 'Kangra',
  tehsil: 'Dharamshala',
  town: 'Dharamshala',
  streetAddress: '12 Temple Road',
  city: 'Dharamshala',
  state: 'Himachal Pradesh',
  pincode: '176215',
  ...PIN,
  description: 'x'.repeat(130),
  photos: photoList(),
  dailyBaseRate: 1500,
  weeklyDiscountPct: 10,
  monthlyDiscountPct: 20,
  minDays: 7,
  availableFrom: '2099-10-15',
  billsIncluded: 'all',
  checkIn: '12:00 pm',
  checkOut: '11:00 am',
  pets: false,
  smoking: false,
  cancellation: 'moderate',
  categories: ['long'],
  amenities: ['Wifi', 'Kitchen', 'Parking', 'Garden'],
  walkthroughPassed: true,
  ...over,
});

const result = (downMbps: number) => ({
  downMbps,
  upMbps: 8,
  pingMs: 30,
  jitterMs: 4,
  connectionType: 'wifi',
  testedAt: NOW,
  capture: { distanceFromPinM: 0, accuracyM: 10, capturedAt: NOW },
});

describe('HostListingsService: Wi-Fi at save and submit', () => {
  let redis: Map<string, string>;
  let rows: Record<string, any>;
  let service: HostListingsService;

  const grantWifiToken = (downMbps: number) =>
    redis.set(
      wifiTestTokenKey('u1', TOKEN),
      JSON.stringify({ ...PIN, record: record({ kind: 'wifi' }), result: result(downMbps) }),
    );

  beforeEach(() => {
    redis = new Map();
    rows = {};
    const listings = {
      findOne: async ({ where }: any) => rows[where.id] ?? null,
      save: async (row: any) => ((row.id ??= 'new-1'), (rows[row.id] = row)),
      create: (v: any) => ({ ...v }),
    };
    const redisSvc = {
      get: async (k: string) => redis.get(k) ?? null,
      set: async (k: string, v: string) => (redis.set(k, v), true),
      del: async (k: string) => void redis.delete(k),
      incrementVersion: async () => 1,
    };
    const profiles = {
      findOne: async () => ({ id: 'u1', host_kind: 'individual', gst: '', selfie_uploaded_at: new Date() }),
    };
    const verification = { getMyStatus: async () => ({ identity: { status: 'verified' } }) };
    const dataSource = { transaction: async (fn: any) => fn({ getRepository: () => listings }) };
    service = new HostListingsService(listings as any, profiles as any, {} as any, redisSvc as any, verification as any, dataSource as any);
  });
  afterEach(async () => service.onModuleDestroy());

  const listing = (extra: Record<string, unknown> = {}) => {
    rows['L1'] = {
      id: 'L1',
      host_id: 'u1',
      status: 'live',
      draft_data: {
        property_details: { ...PIN, photos: photoList() },
        telemetry: {
          walkthroughPassed: true,
          status: 'needs_review',
          walkthroughCheck: { method: 'camera_captured', visuallyVerified: false, capture: record({ kind: 'video' }), warnings: [], checkedAt: NOW },
        },
        captures: { photos: Object.fromEntries([1, 2, 3, 4, 5].map((n) => [url(n), record()])) },
        media: {},
        ...extra,
      },
    };
  };

  it('refuses the Work category at submit without a Wi-Fi test', async () => {
    listing();
    await expect(service.resubmit('u1', 'L1', body({ categories: ['work'], wifiAnswer: 'later' }))).rejects.toThrow(WORK_CATEGORY_MESSAGE);
    expect(rows['L1'].status).toBe('live');
  });

  it('refuses the Work category at submit with a result of 20 Mbps or less, and keeps the receipt', async () => {
    listing();
    grantWifiToken(20);
    await expect(
      service.resubmit('u1', 'L1', body({ categories: ['work'], wifiAnswer: 'yes', wifiTestToken: TOKEN })),
    ).rejects.toThrow(BadRequestException);
    expect(redis.has(wifiTestTokenKey('u1', TOKEN))).toBe(true);
  });

  it('accepts the Work category above 20 Mbps, stores draft_data.wifi, adds Wifi and spends the receipt', async () => {
    listing();
    grantWifiToken(42.3);
    await service.resubmit('u1', 'L1', body({ categories: ['work', 'long'], amenities: ['Kitchen', 'Parking', 'Garden'], wifiAnswer: 'yes', wifiTestToken: TOKEN }));
    const saved = rows['L1'].draft_data;
    expect(saved.wifi).toMatchObject({ answer: 'yes', downMbps: 42.3, upMbps: 8 });
    expect(saved.property_details.amenities).toEqual(['Wifi', 'Kitchen', 'Parking', 'Garden']);
    expect(saved.captures.wifi).toMatchObject({ source: 'device_reported' });
    expect(redis.has(wifiTestTokenKey('u1', TOKEN))).toBe(false);
  });

  it('strips a client-sent Wifi amenity when there is no measured result', async () => {
    listing();
    await service.resubmit('u1', 'L1', body({ wifiAnswer: 'yes' }));
    expect(rows['L1'].draft_data.property_details.amenities).toEqual(['Kitchen', 'Parking', 'Garden']);
  });

  it('keeps a stored result on an unrelated edit without a new token', async () => {
    listing({ wifi: { answer: 'yes', ...result(55) }, captures: { photos: Object.fromEntries([1, 2, 3, 4, 5].map((n) => [url(n), record()])), wifi: record({ kind: 'wifi' }) } });
    await service.resubmit('u1', 'L1', body({ categories: ['work'] }));
    const saved = rows['L1'].draft_data;
    expect(saved.wifi.downMbps).toBe(55);
    expect(saved.property_details.amenities[0]).toBe('Wifi');
  });

  it('save-draft keeps a Work category without a test, but not a client-sent Wifi', async () => {
    const { listingId } = await service.saveDraft('u1', { categories: ['work'], amenities: ['Wifi', 'Kitchen', 'Parking', 'Garden'] });
    const saved = rows[listingId].draft_data;
    expect(saved.property_details.categories).toEqual(['work']);
    expect(saved.property_details.amenities).toEqual(['Kitchen', 'Parking', 'Garden']);
  });

  it('save-draft reads a receipt without spending it', async () => {
    grantWifiToken(30);
    const { listingId } = await service.saveDraft('u1', { ...PIN, wifiAnswer: 'yes', wifiTestToken: TOKEN, amenities: ['Kitchen', 'Parking', 'Garden'] });
    expect(rows[listingId].draft_data.wifi).toMatchObject({ answer: 'yes', downMbps: 30 });
    expect(rows[listingId].draft_data.property_details.amenities).toEqual(['Wifi', 'Kitchen', 'Parking', 'Garden']);
    expect(redis.has(wifiTestTokenKey('u1', TOKEN))).toBe(true);
  });
});
