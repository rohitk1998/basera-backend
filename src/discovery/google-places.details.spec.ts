import { fakeUsage, makeClient } from './discovery.test-utils';

const res = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => '' }) as any;
const PLACE_ID = 'ChIJabcdefghij1234';

describe('GooglePlacesClient.getDetails amenities', () => {
  it('maps the widened Google fields to guest-facing amenities and falls back to the generative summary', async () => {
    const fetch = jest.fn(async () =>
      res({
        displayName: { text: 'Stay' },
        generativeSummary: { overview: { text: 'A quiet riverside homestay.' } },
        allowsDogs: true,
        servesBreakfast: true,
        servesDinner: true,
        restroom: true,
        parkingOptions: { freeParkingLot: true },
        accessibilityOptions: { wheelchairAccessibleEntrance: true, wheelchairAccessibleRestroom: true },
        paymentOptions: { acceptsDebitCards: true },
      }),
    );
    const { client } = makeClient({ GOOGLE_PLACES_API_KEY: 'k' }, fakeUsage(), { fetch });
    const d = await client.getDetails(PLACE_ID, 100);
    expect((fetch.mock.calls[0] as any)[1].headers['X-Goog-FieldMask']).toMatch(/generativeSummary.*paymentOptions/);
    expect(d?.summary).toBe('A quiet riverside homestay.');
    expect(d?.amenities).toEqual(
      expect.arrayContaining(['Pets allowed', 'Free parking', 'Breakfast available', 'Dinner available', 'Step-free entrance', 'Accessible restroom', 'Restroom', 'Cards accepted']),
    );
  });

  it('prefers the editorial summary and returns no amenities when Google has none', async () => {
    const { client } = makeClient({ GOOGLE_PLACES_API_KEY: 'k' }, fakeUsage(), {
      fetch: async () => res({ displayName: { text: 'S' }, editorialSummary: { text: 'Editorial' }, generativeSummary: { overview: { text: 'Gen' } } }),
    });
    const d = await client.getDetails(PLACE_ID, 100);
    expect(d?.summary).toBe('Editorial');
    expect(d?.amenities).toEqual([]);
  });
});
