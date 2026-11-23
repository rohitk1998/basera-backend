import { BadRequestException } from '@nestjs/common';
import { HOST_AUTHORED_FIELDS, assertProvenanceAllowed } from './listing-provenance.util';
import { ListingHistoryService } from './listing-history.service';

describe('content provenance', () => {
  it('google_display_only can never be stored in a host-authored field', () => {
    for (const field of HOST_AUTHORED_FIELDS) {
      expect(() => assertProvenanceAllowed({ field, source: 'google_display_only', permittedUntil: new Date() })).toThrow(
        BadRequestException,
      );
    }
  });

  it('google_display_only elsewhere needs permitted_until', () => {
    expect(() => assertProvenanceAllowed({ field: 'externalRating', source: 'google_display_only' })).toThrow(BadRequestException);
    expect(() =>
      assertProvenanceAllowed({ field: 'externalRating', source: 'google_display_only', permittedUntil: new Date() }),
    ).not.toThrow();
  });

  it('host / admin / licensed are fine; unknown sources are rejected', () => {
    expect(() => assertProvenanceAllowed({ field: 'title', source: 'host' })).not.toThrow();
    expect(() => assertProvenanceAllowed({ field: 'photos', source: 'licensed' })).not.toThrow();
    expect(() => assertProvenanceAllowed({ field: 'title', source: 'scraped' as any })).toThrow(BadRequestException);
  });

  it('the service validates before writing anything', async () => {
    const query = jest.fn();
    const svc = new ListingHistoryService({ query } as any);
    await expect(
      svc.recordProvenance('l1', [
        { field: 'title', source: 'host' },
        { field: 'description', source: 'google_display_only', permittedUntil: new Date() },
      ]),
    ).rejects.toThrow(BadRequestException);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('ListingHistoryService', () => {
  it('records transitions and skips no-ops', async () => {
    const query = jest.fn();
    const svc = new ListingHistoryService({ query } as any);
    await svc.record({ listingId: 'l', from: 'draft', to: 'in_review', actorId: 'u', reason: 'x' });
    await svc.record({ listingId: 'l', from: 'live', to: 'live' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual(['l', 'draft', 'in_review', 'u', 'x']);
  });

  it('writes the typed pricing row', async () => {
    const query = jest.fn();
    await new ListingHistoryService({ query } as any).savePricing('l', { dailyBaseRate: 1000, monthlyPrice: 20000 });
    expect(query.mock.calls[0][0]).toMatch(/INSERT INTO listing_pricing/);
    expect(query.mock.calls[0][1][3]).toBe(20000);
  });
});
