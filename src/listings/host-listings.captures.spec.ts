import { createHash } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { HostListingsService } from './host-listings.service';

/**
 * The submit-time rules for camera-captured media: which photo URLs and which
 * walkthrough a listing may be saved with. Real service, faked storage of
 * everything around it.
 */

const PIN = { lat: 32.219, lng: 76.3234 };
const NOW = new Date().toISOString();

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

const url = (n: number | string) => `https://s.test/u1/photos/${n}.jpg`;
const photoList = (...ids: (number | string)[]) => ids.map((id) => ({ url: url(id), room: 'living' }));

function body(over: Record<string, unknown> = {}) {
  return {
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
    photos: photoList(1, 2, 3, 4, 5),
    dailyBaseRate: 1500,
    weeklyDiscountPct: 10,
    monthlyDiscountPct: 20,
    minDays: 7,
    availableFrom: '2026-10-15',
    billsIncluded: 'all',
    checkIn: '12:00 pm',
    checkOut: '11:00 am',
    pets: false,
    smoking: false,
    cancellation: 'moderate',
    categories: ['long'],
    amenities: ['Wifi', 'Kitchen', 'Parking'],
    walkthroughPassed: true,
    ...over,
  };
}

const capturedWalkthrough = (over: Record<string, unknown> = {}) => ({
  walkthroughPassed: true,
  walkthroughVideoUrl: 'https://s.test/u1/walkthrough/w.webm',
  status: 'needs_review',
  walkthroughCheck: { method: 'camera_captured', visuallyVerified: false, capture: record({ kind: 'video' }), warnings: [], checkedAt: NOW, ...over },
});

describe('HostListingsService: camera-captured media at submit', () => {
  let redis: Map<string, string>;
  let rows: Record<string, any>;
  let service: HostListingsService;

  /** Registers a receipt the way uploadPhotos does. */
  const captureKey = (u: string) => `capture-receipt:u1:${createHash('sha256').update(u).digest('hex')}`;
  const grantReceipt = (u: string, rec = record()) => redis.set(captureKey(u), JSON.stringify(rec));

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
      findOne: async () => ({
        id: 'u1',
        host_kind: 'individual',
        pan: 'ABCDE1234F',
        gst: '',
        selfie_uploaded_at: new Date(),
        bank_verified_at: new Date(),
      }),
    };
    const verification = { getMyStatus: async () => ({ identity: { status: 'verified' }, pan: { status: 'verified' } }) };
    const dataSource = { transaction: async (fn: any) => fn({ getRepository: () => listings }) };
    service = new HostListingsService(listings as any, profiles as any, {} as any, redisSvc as any, verification as any, dataSource as any);
  });
  afterEach(async () => service.onModuleDestroy());

  const listing = (draft: Record<string, any>, status = 'live') => {
    rows['L1'] = { id: 'L1', host_id: 'u1', status, draft_data: draft };
    return rows['L1'];
  };

  /** A listing as it exists after a normal camera-captured submit. */
  const capturedDraft = () => ({
    property_details: { ...PIN, photos: photoList(1, 2, 3, 4, 5) },
    telemetry: capturedWalkthrough(),
    captures: { photos: Object.fromEntries([1, 2, 3, 4, 5].map((n) => [url(n), record()])) },
    media: {},
  });
  /** A listing as it exists from before camera capture: GPS-tag walkthrough, photos with no capture data. */
  const legacyDraft = () => ({
    property_details: { ...PIN, photos: photoList('a', 'b', 'c', 'd', 'e') },
    telemetry: {
      walkthroughPassed: true,
      walkthroughToken: '2d6f4a1e-5b0e-4d6a-9d3e-0a6f5c2b7f11',
      walkthroughVideoUrl: 'https://s.test/u1/walkthrough/old.mp4',
      status: 'needs_review',
      walkthroughCheck: { method: 'gps_tag_only', gpsTagWithinRadius: true, visuallyVerified: false, distanceMetres: 20, warnings: [], checkedAt: NOW },
    },
    media: {},
  });

  it('keeps pre-capture photos and the pre-capture walkthrough when an unrelated field is edited', async () => {
    listing(legacyDraft());
    await service.resubmit('u1', 'L1', body({ title: 'A new name', photos: photoList('a', 'b', 'c', 'd', 'e') }));
    const saved = rows['L1'].draft_data;
    expect(saved.property_details.title).toBe('A new name');
    expect(saved.captures.photos).toEqual({}); // no capture data invented for old photos
    expect(saved.telemetry.walkthroughCheck.method).toBe('gps_tag_only'); // untouched, still labelled as it was
    expect(saved.telemetry.walkthroughVideoUrl).toBe('https://s.test/u1/walkthrough/old.mp4');
    expect(rows['L1'].status).toBe('in_review');
  });

  it('keeps a stored camera capture on an unrelated edit, re-measured against the pin', async () => {
    listing(capturedDraft());
    await service.resubmit('u1', 'L1', body());
    const saved = rows['L1'].draft_data;
    expect(Object.keys(saved.captures.photos)).toHaveLength(5);
    expect(saved.telemetry.walkthroughCheck.method).toBe('camera_captured');
    expect(saved.telemetry.walkthroughCheck.capture.distanceFromPinM).toBe(0);
  });

  it('accepts a NEW photo only with a capture receipt, and stores its capture data', async () => {
    listing(capturedDraft());
    grantReceipt(url('new'), record({ distanceFromPinM: 40, lat: PIN.lat + 0.0003 }));
    await service.resubmit('u1', 'L1', body({ photos: photoList(1, 2, 3, 4, 'new') }));
    const caps = rows['L1'].draft_data.captures.photos;
    expect(Object.keys(caps).sort()).toEqual([url(1), url(2), url(3), url(4), url('new')].sort());
    expect(caps[url('new')]).toMatchObject({ source: 'device_reported' });
    expect(caps[url('new')].distanceFromPinM).toBeGreaterThan(20); // re-measured, not the client's number
    expect(caps[url(5)]).toBeUndefined(); // dropped photo's capture is dropped with it
  });

  it('refuses a new photo that never went through the camera upload (a URL typed into the form)', async () => {
    listing(capturedDraft());
    await expect(service.resubmit('u1', 'L1', body({ photos: photoList(1, 2, 3, 4, 'forged') }))).rejects.toThrow(/Photo 5 is not a photo taken with the in-app camera/);
    expect(rows['L1'].status).toBe('live'); // nothing was changed
  });

  it('refuses a receipt that belongs to another host', async () => {
    listing(capturedDraft());
    redis.set(`capture-receipt:someone-else:${createHash('sha256').update(url('stolen')).digest('hex')}`, JSON.stringify(record()));
    await expect(service.resubmit('u1', 'L1', body({ photos: photoList(1, 2, 3, 4, 'stolen') }))).rejects.toThrow(BadRequestException);
  });

  it('names the photos that are too far from a pin that has since moved', async () => {
    listing(capturedDraft());
    // Photos are checked before the walkthrough (which spends its receipt last),
    // so with both out of range it is the photos that are named first.
    await expect(service.resubmit('u1', 'L1', body({ lat: PIN.lat + 0.01 }))).rejects.toThrow(/captured more than 200 m from the pin you have now/);
    // photos alone: a pin moved away only for the photo check
    listing({ ...capturedDraft(), telemetry: {} });
    redis.set(`walkthrough-token:u1:00000000-0000-4000-8000-000000000001`, JSON.stringify({ lat: PIN.lat + 0.01, lng: PIN.lng, check: capturedWalkthrough().walkthroughCheck, videoUrl: 'https://s.test/u1/walkthrough/w.webm' }));
    const moved = { lat: PIN.lat + 0.01, walkthroughToken: '00000000-0000-4000-8000-000000000001' };
    // the receipt's capture point is at the old pin, so the walkthrough itself is also out of range here
    await expect(service.resubmit('u1', 'L1', body(moved))).rejects.toThrow(/from the pin you have now/);
  });

  it('refuses captured photos when only the photos are away from the moved pin, naming them', async () => {
    listing(capturedDraft());
    // Walkthrough recorded near the NEW pin; the five stored photos are still at the old one.
    const nearNew = capturedWalkthrough({ capture: record({ kind: 'video', lat: PIN.lat + 0.01 }) });
    redis.set(`walkthrough-token:u1:00000000-0000-4000-8000-000000000002`, JSON.stringify({ lat: PIN.lat + 0.01, lng: PIN.lng, check: nearNew.walkthroughCheck, videoUrl: nearNew.walkthroughVideoUrl }));
    await expect(
      service.resubmit('u1', 'L1', body({ lat: PIN.lat + 0.01, walkthroughToken: '00000000-0000-4000-8000-000000000002' })),
    ).rejects.toThrow(/Photos 1, 2, 3, 4, 5 were captured more than 200 m from the pin you have now/);
  });

  it('a pre-capture walkthrough does not survive the pin moving away, and a draft row is never trusted as pre-capture', async () => {
    listing(legacyDraft());
    await expect(service.resubmit('u1', 'L1', body({ lat: PIN.lat + 0.01, photos: photoList('a', 'b', 'c', 'd', 'e') }))).rejects.toThrow(/pin has moved since the walkthrough/);

    // A draft whose telemetry flags came from a client (save-draft used to copy them) is not a walkthrough.
    const forged = legacyDraft();
    delete (forged.telemetry as any).walkthroughCheck;
    listing(forged, 'draft');
    await expect(service.submitFull('u1', body({ photos: photoList('a', 'b', 'c', 'd', 'e') }), 'L1')).rejects.toThrow(/Record the walkthrough video with the camera/);
  });

  it('redeems a fresh walkthrough receipt once, and saves the server-issued video URL', async () => {
    listing(capturedDraft());
    const fresh = capturedWalkthrough({ capture: record({ kind: 'video', distanceFromPinM: 30, lat: PIN.lat + 0.0002 }) });
    const token = '00000000-0000-4000-8000-000000000003';
    redis.set(`walkthrough-token:u1:${token}`, JSON.stringify({ ...PIN, check: fresh.walkthroughCheck, videoUrl: 'https://s.test/u1/walkthrough/NEW.webm' }));
    await service.resubmit('u1', 'L1', body({ walkthroughToken: token, walkthroughVideoUrl: 'https://evil.test/x.mp4' }));
    const t = rows['L1'].draft_data.telemetry;
    expect(t.walkthroughVideoUrl).toBe('https://s.test/u1/walkthrough/NEW.webm'); // not the client's
    expect(t.walkthroughCheck.capture.distanceFromPinM).toBeGreaterThan(10);
    expect(t.status).toBe('needs_review');
    expect(t.walkthroughToken).toBeUndefined(); // a spent token is not stored
    expect(redis.has(`walkthrough-token:u1:${token}`)).toBe(false);
  });

  it('refuses a submit with neither a recording nor one on file', async () => {
    [1, 2, 3, 4, 5].forEach((n) => grantReceipt(url(n)));
    await expect(service.submitFull('u1', body({ walkthroughToken: undefined }))).rejects.toThrow(/Record the walkthrough video with the camera/);
    await expect(service.submitFull('u1', body({ walkthroughToken: '00000000-0000-4000-8000-0000000000ff' }))).rejects.toThrow(/expired or was already used/);
  });

  it('does not let a new property video through, but keeps one already on the listing', async () => {
    const d = legacyDraft() as any;
    d.media = { videoUrl: 'https://s.test/u1/video/old.mp4' };
    listing(d);
    await service.resubmit('u1', 'L1', body({ videoUrl: 'https://s.test/u1/video/old.mp4', photos: photoList('a', 'b', 'c', 'd', 'e') }));
    expect(rows['L1'].draft_data.media.videoUrl).toBe('https://s.test/u1/video/old.mp4');
    rows['L1'].status = 'live';
    await expect(service.resubmit('u1', 'L1', body({ videoUrl: 'https://s.test/u1/video/new.mp4', photos: photoList('a', 'b', 'c', 'd', 'e') }))).rejects.toThrow(/can no longer be uploaded/);
  });

  it('keeps the walkthrough receipt when a later check refuses the submit', async () => {
    const token = '00000000-0000-4000-8000-000000000005';
    redis.set(`walkthrough-token:u1:${token}`, JSON.stringify({ ...PIN, check: capturedWalkthrough().walkthroughCheck, videoUrl: 'https://s.test/u1/walkthrough/w.webm' }));
    // photos have no receipts, so the submit is refused after the token was read
    await expect(service.submitFull('u1', body({ walkthroughToken: token }))).rejects.toThrow(/Photo 1 is not a photo taken/);
    expect(redis.has(`walkthrough-token:u1:${token}`)).toBe(true);
  });

  it('refuses a live listing in save-draft instead of pulling it into review half-filled', async () => {
    listing(capturedDraft(), 'live');
    await expect(service.saveDraft('u1', { title: 'Half done' }, 'L1')).rejects.toThrow(/live listing cannot be saved as a draft/);
    expect(rows['L1'].status).toBe('live');
  });

  it('saves a cleared text field and an emptied photo list in a draft', async () => {
    listing({ ...capturedDraft(), property_details: { ...PIN, title: 'Old title', photos: photoList(1, 2) } }, 'draft');
    await service.saveDraft('u1', { title: '', photos: [] }, 'L1');
    const saved = rows['L1'].draft_data.property_details;
    expect(saved.title).toBeUndefined();
    expect(saved.photos).toEqual([]);
  });

  describe('save-draft', () => {
    it('does not copy a client-set walkthroughPassed / video URL into the draft', async () => {
      await service.saveDraft('u1', { title: 'Half done', walkthroughPassed: true, walkthroughVideoUrl: 'https://evil.test/x.mp4' });
      const saved = rows['new-1'].draft_data;
      expect(saved.telemetry).toEqual({});
    });

    it('refuses a photo URL that is neither on the draft nor a camera capture', async () => {
      await expect(service.saveDraft('u1', { photos: photoList('forged') })).rejects.toThrow(/Photo 1 is not a photo taken with the in-app camera/);
    });

    it('stores a captured photo, and a live walkthrough receipt, without spending the receipt', async () => {
      grantReceipt(url('p1'));
      const token = '00000000-0000-4000-8000-000000000004';
      redis.set(`walkthrough-token:u1:${token}`, JSON.stringify({ ...PIN, check: capturedWalkthrough().walkthroughCheck, videoUrl: 'https://s.test/u1/walkthrough/w.webm' }));
      await service.saveDraft('u1', { ...PIN, photos: photoList('p1'), walkthroughToken: token });
      const saved = rows['new-1'].draft_data;
      expect(Object.keys(saved.captures.photos)).toEqual([url('p1')]);
      expect(saved.telemetry.walkthroughCheck.method).toBe('camera_captured');
      expect(redis.has(`walkthrough-token:u1:${token}`)).toBe(true); // still redeemable at submit
    });
  });
});
