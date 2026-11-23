import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { DataSource } from 'typeorm';
import { GooglePlacesClient } from './google-places.client';
import { DiscoveredDetailsService } from './discovered-details.service';
import { discoveredOpenSql } from './discovered-predicate';

const ATTRIBUTION = 'Place data, photos and reviews from Google Maps.';
/** Town (as searched in discovery) -> district, so district views can include discovered stays. */
const TOWN_DISTRICT: Record<string, string> = {
  manali: 'Kullu', naggar: 'Kullu', kasol: 'Kullu', jibhi: 'Kullu', 'tirthan valley': 'Kullu',
  bir: 'Kangra', dharamshala: 'Kangra',
};
const PHOTO_BUDGET = Number(process.env.DISCOVERED_PHOTOS_DAILY_BUDGET ?? 2000);

/**
 * Public, unauthenticated, read-only. Shows properties found on Google that no host has claimed yet, clearly as
 * "not yet verified". Name/address/rating/photo are fetched LIVE from Google and held in memory for 30 minutes at most
 * (never written to our database). Nothing here can book, message or reveal a phone number; a guest can only send a
 * request (POST /api/inquiries with candidateRef).
 */
@Controller('api/discovered')
export class DiscoveredPublicController {
  /** listing id -> Google place id (our own data). Saves a DB round trip per photo when a page loads 10 at once. */
  private placeIds = new Map<string, string>();

  constructor(
    private readonly ds: DataSource,
    private readonly places: GooglePlacesClient,
    private readonly details: DiscoveredDetailsService,
  ) {}

  private towns(destination?: string, q?: string, district?: string): string[] | null {
    const dest = (destination ?? '').trim().toLowerCase();
    const query = (q ?? '').trim().toLowerCase();
    const dist = (district ?? '').trim().toLowerCase();
    if (!dest && !query && !dist) return null; // no filter: everything
    return Object.keys(TOWN_DISTRICT).filter(
      (t) =>
        (!dest || t === dest) &&
        (!dist || TOWN_DISTRICT[t].toLowerCase() === dist) &&
        (!query || t.includes(query) || query.includes(t) || TOWN_DISTRICT[t].toLowerCase() === query),
    );
  }

  private async toItem(full: boolean, r: { id: string; external_place_id: string; discovery_destination: string | null; lat: number | null; lng: number | null; pd?: any }) {
    const d = await this.details.get(r.external_place_id);
    if (!d?.name) return null; // Google unavailable/closed: show nothing rather than a blank card
    const town = (r.discovery_destination ?? '').toLowerCase();
    return {
      id: r.id,
      destination: r.discovery_destination,
      district: TOWN_DISTRICT[town] ?? null,
      lat: r.lat,
      lng: r.lng,
      name: d.name,
      address: d.address,
      rating: d.rating,
      ratingCount: d.ratingCount,
      mapsUrl: d.mapsUrl,
      photoUrl: d.photoName ? `/api/discovered/${r.id}/photo` : null,
      photoCount: d.photoNames.length,
      verified: false,
      ...(full ? { summary: d.summary, amenities: d.amenities, reviews: d.reviews, owner: DiscoveredPublicController.ownerFields(r.pd) } : {}),
    };
  }

  /** Our own research data (draft_data.property_details), whitelisted. Same fields an owner listing shows. */
  private static ownerFields(pd: any) {
    if (!pd || typeof pd !== 'object') return null;
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
    const t = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : null);
    return {
      propertyType: t(pd.propertyType), placeType: t(pd.placeType), beds: t(pd.beds),
      bedrooms: typeof pd.bedrooms === 'number' ? pd.bedrooms : null,
      bathrooms: n(pd.bathrooms), maxGuests: n(pd.maxGuests), dailyBaseRate: n(pd.dailyBaseRate),
      amenities: Array.isArray(pd.amenities) ? pd.amenities.filter((a: unknown) => typeof a === 'string').slice(0, 40) : [],
    };
  }

  private static readonly COLS = `id, external_place_id, discovery_destination,
    NULLIF(draft_data#>>'{discovery,lat}','')::float8 AS lat, NULLIF(draft_data#>>'{discovery,lng}','')::float8 AS lng,
    draft_data->'property_details' AS pd`;
  private static readonly OPEN = discoveredOpenSql('');

  @Get()
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async list(
    @Query('destination') destination?: string,
    @Query('q') q?: string,
    @Query('district') district?: string,
    @Query('limit') limit?: string,
  ) {
    const n = Math.min(Math.max(parseInt(limit ?? '12', 10) || 12, 1), 24);
    const towns = this.towns(destination, q, district);
    if (towns && towns.length === 0) return { success: true, items: [], attribution: ATTRIBUTION };
    const rows = await this.ds.query(
      `SELECT ${DiscoveredPublicController.COLS} FROM listings
        WHERE ${DiscoveredPublicController.OPEN}
          AND ($1::text[] IS NULL OR lower(discovery_destination) = ANY($1::text[]))
        ORDER BY discovered_at DESC LIMIT $2`,
      [towns, n],
    );
    const items = (await Promise.all(rows.map((r: any) => this.toItem(false, r)))).filter(Boolean);
    return { success: true, items, attribution: ATTRIBUTION };
  }

  @Get(':id')
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  async one(@Param('id', ParseUUIDPipe) id: string) {
    const rows = await this.ds.query(
      `SELECT ${DiscoveredPublicController.COLS} FROM listings WHERE id = $1 AND ${DiscoveredPublicController.OPEN}`,
      [id],
    );
    const item = rows[0] ? await this.toItem(true, rows[0]) : null;
    if (!item) throw new NotFoundException();
    return { success: true, item, attribution: ATTRIBUTION };
  }

  @Get(':id/photo')
  @Throttle({ default: { ttl: 60_000, limit: 120 } })
  async photo(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response, @Query('i') i?: string) {
    const idx = Math.min(Math.max(parseInt(i ?? '0', 10) || 0, 0), 9);
    let placeId = this.placeIds.get(id);
    if (!placeId) {
      const rows = await this.ds.query(
        `SELECT external_place_id FROM listings WHERE id = $1 AND ${DiscoveredPublicController.OPEN}`,
        [id],
      );
      if (!rows[0]) throw new NotFoundException();
      placeId = rows[0].external_place_id as string;
      if (this.placeIds.size > 2000) this.placeIds.clear();
      this.placeIds.set(id, placeId);
    }
    const d = await this.details.get(placeId);
    const name = d?.photoNames[idx] ?? null;
    const img = name ? await this.places.getPhoto(name, PHOTO_BUDGET) : null;
    if (!img) throw new NotFoundException();
    res.setHeader('Content-Type', img.contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    res.send(img.body);
  }
}
