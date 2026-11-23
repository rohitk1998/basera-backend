import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { discoveredGridSql } from './discovered-predicate';
import type { Listing } from '../listings/listing.types';
import { DiscoveryUsageService } from './discovery-usage.service';
import { GooglePlacesClient, PlaceDetails } from './google-places.client';

export type DiscoveredDetails = PlaceDetails;

export const DETAILS_TTL_MS = 30 * 60_000;
export const NEGATIVE_TTL_MS = 2 * 60_000;
const CACHE_MAX = 1000;
const CONCURRENCY = 4;
const CALL_TIMEOUT_MS = 2500;
const DEADLINE_MS = 3000;
export const HYDRATE_MAX = 24;
const DETAILS_BUDGET = () => Number(process.env.DISCOVERED_DETAILS_DAILY_BUDGET ?? 1000);

interface Entry { d: DiscoveredDetails | null; expires: number }

const msToUtcMidnight = () => {
  const n = new Date();
  return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1) - n.getTime();
};

/**
 * ONE in-memory cache of live Google details, shared by /api/discovered, its photo route and /api/listings.
 * Never persisted (Google terms): nothing here is written to the database or Redis.
 */
@Injectable()
export class DiscoveredDetailsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DiscoveredDetailsService.name);
  /** Insertion order = recency (entries are re-inserted on hit). */
  private cache = new Map<string, Entry>();
  private inflight = new Map<string, Promise<DiscoveredDetails | null>>();

  private warmTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly places: GooglePlacesClient,
    private readonly usage: DiscoveryUsageService,
    private readonly ds: DataSource,
  ) {}

  /**
   * Keeps the first grid page warm so a guest never waits on Google (cold /stays was ~4.7 s). In-memory only, same 30 min
   * TTL as before. Budget: WARM_MAX places every WARM_EVERY_MS (default 12 x ~51/day = ~612 of the 1000/day details
   * budget); skipped when little budget is left, so it can never starve live traffic.
   */
  onApplicationBootstrap() {
    const max = Number(process.env.DISCOVERED_WARM_MAX ?? 12);
    if (!(max > 0) || process.env.QUEUE_WORKERS === 'false') return;
    const every = Number(process.env.DISCOVERED_WARM_EVERY_MS ?? 28 * 60_000);
    setTimeout(() => void this.warm(max), 5_000).unref();
    this.warmTimer = setInterval(() => void this.warm(max), every);
    this.warmTimer.unref();
  }

  onModuleDestroy() {
    if (this.warmTimer) clearInterval(this.warmTimer);
  }

  async warm(max: number): Promise<number> {
    try {
      if (this.places.blockedReason()) return 0;
      if ((await this.usage.remaining(`${this.places.sourceKey}_details`, DETAILS_BUDGET())) < 300) return 0;
      const rows: { external_place_id: string }[] = await this.ds.query(
        `SELECT l.external_place_id FROM listings l WHERE ${discoveredGridSql('l')} ORDER BY l.created_at DESC, l.id DESC LIMIT $1`,
        [max],
      );
      const map = await this.hydrateMany(rows.map((r) => r.external_place_id), { deadlineMs: 20_000 });
      const n = [...map.values()].filter(Boolean).length;
      this.logger.log(`warmed ${n}/${rows.length} discovered place details`);
      return n;
    } catch (e: any) {
      this.logger.warn(`warm failed: ${e?.message ?? e}`);
      return 0;
    }
  }

  private put(placeId: string, d: DiscoveredDetails | null, ttl: number) {
    this.cache.delete(placeId);
    this.cache.set(placeId, { d, expires: Date.now() + ttl });
    if (this.cache.size > CACHE_MAX) {
      const now = Date.now();
      for (const [k, v] of this.cache) if (v.expires <= now) this.cache.delete(k);
      while (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
    }
  }

  private peek(placeId: string): Entry | undefined {
    const e = this.cache.get(placeId);
    if (!e) return undefined;
    if (e.expires <= Date.now()) {
      this.cache.delete(placeId);
      return undefined;
    }
    this.cache.delete(placeId);
    this.cache.set(placeId, e);
    return e;
  }

  private async load(placeId: string): Promise<DiscoveredDetails | null> {
    try {
      if (this.places.blockedReason()) {
        this.put(placeId, null, NEGATIVE_TTL_MS); // breaker open / no key: no Google work, no budget touched
        return null;
      }
      const budget = DETAILS_BUDGET();
      if ((await this.usage.remaining(`${this.places.sourceKey}_details`, budget)) <= 0) {
        this.put(placeId, null, msToUtcMidnight());
        return null;
      }
      const ctl = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          ctl.abort();
          resolve(null);
        }, CALL_TIMEOUT_MS);
      });
      let d: DiscoveredDetails | null = null;
      try {
        d = await Promise.race([this.places.getDetails(placeId, budget, ctl.signal).catch(() => null), timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      this.put(placeId, d, d ? DETAILS_TTL_MS : NEGATIVE_TTL_MS);
      return d;
    } catch (e: any) {
      this.logger.warn(`details failed: ${e?.message ?? e}`);
      this.put(placeId, null, NEGATIVE_TTL_MS);
      return null;
    }
  }

  async get(placeId: string): Promise<DiscoveredDetails | null> {
    const hit = this.peek(placeId);
    if (hit) return hit.d;
    const running = this.inflight.get(placeId);
    if (running) return running;
    const p = this.load(placeId).finally(() => this.inflight.delete(placeId));
    this.inflight.set(placeId, p);
    return p;
  }

  async hydrateMany(placeIds: string[], opts: { deadlineMs?: number } = {}): Promise<Map<string, DiscoveredDetails | null>> {
    const ids = [...new Set(placeIds)];
    const out = new Map<string, DiscoveredDetails | null>();
    const queue = [...ids];
    let expired = false;
    const worker = async () => {
      while (!expired) {
        const id = queue.shift();
        if (id === undefined) return;
        const d = await this.get(id);
        if (!expired) out.set(id, d);
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        expired = true;
        resolve();
      }, opts.deadlineMs ?? DEADLINE_MS);
    });
    try {
      await Promise.race([
        Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker)),
        deadline,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    // Anything unfinished: cache if we have it, otherwise the card keeps its fallback.
    for (const id of ids) if (!out.has(id)) out.set(id, this.peek(id)?.d ?? null);
    return out;
  }

  /** Returns shallow copies (the input may be a cached/coalesced object). Never throws. */
  async hydrateListings(listings: Listing[], opts: { hydrate: boolean }): Promise<Listing[]> {
    const copies = (listings ?? []).map((l) => {
      if (!l || !(l as any).discovered) return l;
      const { placeId: _drop, ...rest } = l as any;
      return { ...rest, photos: Array.isArray(rest.photos) ? [...rest.photos] : [] } as Listing;
    });
    if (!opts.hydrate) return copies;
    try {
      const wanted: string[] = [];
      for (const l of listings ?? []) {
        const pid = (l as any)?.discovered ? (l as any).placeId : null;
        if (typeof pid === 'string' && pid && wanted.length < HYDRATE_MAX && !wanted.includes(pid)) wanted.push(pid);
      }
      const map = wanted.length ? await this.hydrateMany(wanted) : new Map<string, DiscoveredDetails | null>();
      return copies.map((c, i) => {
        const src: any = listings[i];
        if (!src?.discovered) return c;
        const d = map.get(src.placeId);
        if (!d?.name) return c;
        const out: any = { ...c, title: d.name, titleIsFallback: false };
        if (d.photoNames.length > 0) out.photos = [{ url: `/api/discovered/${src.id}/photo?i=0`, room: 'exterior' }];
        // Live Google rating, held in memory only (never stored).
        if (typeof d.rating === 'number' && d.rating > 0) {
          out.rating = d.rating;
          out.reviewCount = typeof d.ratingCount === 'number' ? d.ratingCount : null;
        }
        return out as Listing;
      });
    } catch (e: any) {
      this.logger.warn(`hydrateListings failed: ${e?.message ?? e}`);
      return copies;
    }
  }
}
