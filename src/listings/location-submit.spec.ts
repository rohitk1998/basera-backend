import { fullOnboardingSchema } from './listing-schema';
import { assertLocationIsValid, upgradeLegacyLocation } from './location.util';

/** A complete, valid listing payload, without the location fields. */
const rest = {
  title: 'Deodar Nest Homestay',
  propertyType: 'house',
  placeType: 'entire',
  beds: '2BHK',
  bedrooms: 2,
  bathrooms: 1,
  maxGuests: 4,
  flatNumber: '',
  streetAddress: 'Near the old temple, Vashisht village',
  landmark: '',
  locality: '',
  city: 'Manali',
  state: 'Himachal Pradesh',
  pincode: '175131',
  description: 'A quiet two-bedroom home with a deodar-lined balcony, let by the month. '.repeat(3),
  theSpace: '',
  guestAccess: '',
  photos: Array.from({ length: 5 }, (_, i) => ({ url: `https://example.com/p${i}.jpg`, room: 'exterior' })),
  dailyBaseRate: 1500,
  weeklyDiscountPct: 0,
  monthlyDiscountPct: 10,
  minDays: 30,
  availableFrom: '2026-10-20',
  billsIncluded: 'all',
  checkIn: '12:00 pm – 9:00 pm',
  checkOut: 'Before 11:00 am',
  pets: false,
  smoking: false,
  cancellation: 'moderate',
  categories: ['quiet'],
  amenities: ['Wifi', 'Kitchen', 'Heating'],
  walkthroughPassed: true,
  walkthroughToken: '3b2d1623-b9fd-42f0-984e-97ef53a95a9f',
  videoUrl: '',
  tourUrl: '',
};

/** What the server does with a submitted body, minus the database. */
function accept(body: Record<string, unknown>) {
  const parsed = fullOnboardingSchema.safeParse(upgradeLegacyLocation(body));
  if (!parsed.success) return { ok: false as const, message: parsed.error.issues[0]?.message };
  try {
    assertLocationIsValid(parsed.data);
  } catch (e) {
    return { ok: false as const, message: (e as Error).message };
  }
  return { ok: true as const, data: parsed.data };
}

describe('submitting a listing location', () => {
  it('accepts a new client: district, tehsil, exact location and a pin anywhere in the state', () => {
    const r = accept({ ...rest, district: 'Kullu', tehsil: 'Manali', town: 'Manali', lat: 32.2701, lng: 77.1755 });
    expect(r.ok).toBe(true);
  });

  it('accepts a district that was never in the old list of 18 towns', () => {
    const r = accept({ ...rest, district: 'Hamirpur', tehsil: 'Barsar', lat: 31.64, lng: 76.4, city: 'Barsar', pincode: '177021' });
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.data.town).toBe('Barsar'); // town follows the tehsil when the client sends none
  });

  it('still accepts an older app build that sends only a town from the old list', () => {
    const r = accept({ ...rest, town: 'Dharamshala', lat: 32.219, lng: 76.3234 });
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && [r.data.district, r.data.tehsil, r.data.town]).toEqual(['Kangra', 'Dharamshala', 'Dharamshala']);
  });

  it('refuses a location with no district and an unknown town', () => {
    expect(accept({ ...rest, town: 'Atlantis', lat: 32.2, lng: 77.1 }).ok).toBe(false);
  });

  it('refuses a tehsil from another district, and says which district', () => {
    const r = accept({ ...rest, district: 'Kullu', tehsil: 'Dharamshala', town: 'Dharamshala', lat: 32.2, lng: 77.1 });
    expect(r).toEqual({ ok: false, message: 'Choose a tehsil that belongs to Kullu district.' });
  });

  it('refuses a pin outside Himachal Pradesh, even with a valid district and tehsil', () => {
    const r = accept({ ...rest, district: 'Solan', tehsil: 'Parwanoo', lat: 30.7333, lng: 76.7794 }); // Chandigarh
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.message).toMatch(/outside Himachal Pradesh/);
  });

  it('refuses a missing pin with the message the form shows', () => {
    const r = accept({ ...rest, district: 'Kullu', tehsil: 'Manali' });
    expect(r).toEqual({ ok: false, message: 'Drop the pin on the property.' });
  });

  it('refuses a state other than Himachal Pradesh', () => {
    expect(accept({ ...rest, district: 'Kullu', tehsil: 'Manali', state: 'Punjab', lat: 32.2, lng: 77.1 }).ok).toBe(false);
  });
});
