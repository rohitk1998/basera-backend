import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { hostname } from 'os';
import { runExclusive } from '../common/leader-lock';
import { deriveDiscoveredLocation } from '../listings/discovered-location.util';
import { SEARCH_CACHE_VERSION_KEY } from '../listings/listings.service';
import { RedisService } from '../redis/redis.service';
import { DiscoveryJobEntity } from './discovery-job.entity';
import {
  DUPLICATE_DISTANCE_M, EXCLUDED_TYPES, HOMESTAY_NAME, LODGING_TYPES, MAX_PAGES_PER_QUERY,
} from './discovery.constants';
import { boundingBox, haversineMetres } from './geo.util';
import { GooglePlacesClient, PlaceCandidate, PlacesBlockedError, PlacesBudgetExhaustedError } from './google-places.client';

const JOB_LOCK_TTL_MS = 15 * 60_000;
/** "homestay" -> "homestays in Manali, Himachal Pradesh, India": plural phrasing steers Google away from hotels. */
export const queryFor = (category: string, destination: string) => {
  const c = category.trim().toLowerCase();
  return `${c.endsWith('s') ? c : `${c}s`} in ${destination}, Himachal Pradesh, India`;
};

@Injectable()
export class DiscoveryRunnerService {
  private readonly logger = new Logger(DiscoveryRunnerService.name);
  private readonly owner = `${hostname()}:${process.pid}`;

  constructor(
    private readonly ds: DataSource,
    private readonly client: GooglePlacesClient,
    private readonly config?: ConfigService,
    @Optional() private readonly redis?: RedisService,
  ) {}

  /** Runs one job under a distributed lock. Never throws for expected outcomes (blocked, budget, cancelled). */
  async run(jobId: string): Promise<{ ran: boolean }> {
    const r = await runExclusive(`discovery:job:${jobId}`, JOB_LOCK_TTL_MS, async () => {
      try {
        await this.execute(jobId);
      } finally {
        await this.bumpSearchVersion(); // once per job, not per insert; harmless if nothing was added
      }
    });
    return { ran: r.ran };
  }

  private async bumpSearchVersion(): Promise<void> {
    try { await this.redis?.incrementVersion(SEARCH_CACHE_VERSION_KEY); } catch { this.logger.warn('search cache bump failed'); }
  }

  private async setStatus(jobId: string, status: string, error: string | null = null, finished = true) {
    await this.ds.query(
      `UPDATE discovery_jobs SET status=$2, error=$3, finished_at=CASE WHEN $4 THEN now() ELSE finished_at END, lock_owner=NULL WHERE id=$1`,
      [jobId, status, error, finished],
    );
  }

  private async currentStatus(jobId: string): Promise<string | undefined> {
    const rows = await this.ds.query('SELECT status FROM discovery_jobs WHERE id=$1', [jobId]);
    return rows[0]?.status;
  }

  private async execute(jobId: string): Promise<void> {
    const rows: DiscoveryJobEntity[] = await this.ds.query('SELECT * FROM discovery_jobs WHERE id=$1', [jobId]);
    const job = rows[0];
    if (!job || !['queued', 'running'].includes(job.status)) return; // cancelled / paused / done: nothing to do

    const blocked = this.client.blockedReason();
    if (blocked) return this.setStatus(jobId, 'failed', blocked); // fail cleanly; never fabricate inventory

    await this.ds.query(
      `UPDATE discovery_jobs SET status='running', lock_owner=$2, started_at=COALESCE(started_at, now()), error=NULL WHERE id=$1`,
      [jobId, this.owner],
    );
    const settings = (await this.ds.query('SELECT max_new_per_run, daily_request_budget FROM discovery_settings WHERE destination=$1', [job.destination]))[0];
    const budget: number = settings?.daily_request_budget ?? 100;
    const maxNew: number = job.max_new ?? settings?.max_new_per_run ?? 50;
    const state = { newCount: job.new_count, dup: job.duplicate_count, requests: job.requests_used };

    try {
      outer: for (const category of job.categories) {
        let token: string | undefined;
        for (let page = 0; page < MAX_PAGES_PER_QUERY; page++) {
          const st = await this.currentStatus(jobId);
          if (st === 'paused' || st === 'cancelled') return; // honoured between pages; row already carries the status
          if (state.newCount >= maxNew) break outer;

          const res = await this.client.searchText({ textQuery: queryFor(category, job.destination), destination: job.destination, pageToken: token, budget });
          state.requests++;
          for (const p of res.places) {
            if (state.newCount >= maxNew) break;
            if (p.types.some((t) => EXCLUDED_TYPES.has(t)) && !HOMESTAY_NAME.test(p.displayName ?? '')) continue;
            if (p.types.length && !p.types.some((t) => LODGING_TYPES.has(t))) continue;
            // Acquisition needs a phone to reach the owner: skip places Google lists without one.
            if (p.hasPhone === false) continue;
            (await this.insertCandidate(p, job.destination, category)) ? state.newCount++ : state.dup++;
          }
          await this.ds.query(
            `UPDATE discovery_jobs SET requests_used=$2, new_count=$3, duplicate_count=$4 WHERE id=$1 AND status='running'`,
            [jobId, state.requests, state.newCount, state.dup],
          );
          token = res.nextPageToken;
          if (!token) break;
        }
      }
      if ((await this.currentStatus(jobId)) === 'running') await this.setStatus(jobId, 'done');
    } catch (e: any) {
      if (e instanceof PlacesBudgetExhaustedError) {
        // Resumable tomorrow (or after the budget is raised): paused, not failed.
        await this.ds.query(`UPDATE discovery_jobs SET status='paused', error=$2, requests_used=$3, new_count=$4, duplicate_count=$5, lock_owner=NULL WHERE id=$1 AND status='running'`,
          [jobId, e.message, state.requests, state.newCount, state.dup]);
      } else {
        const msg = e instanceof PlacesBlockedError ? e.message : `error: ${e?.message ?? e}`;
        this.logger.warn(`job ${jobId} failed: ${msg}`);
        await this.ds.query(`UPDATE discovery_jobs SET requests_used=$2, new_count=$3, duplicate_count=$4 WHERE id=$1`, [jobId, state.requests, state.newCount, state.dup]);
        await this.setStatus(jobId, 'failed', msg);
      }
    }
  }

  /** @returns true if a new row was inserted, false if the place was already known. */
  async insertCandidate(p: PlaceCandidate, destination: string, category: string): Promise<boolean> {
    const source = this.client.sourceKey;
    const known = await this.ds.query(
      'SELECT 1 FROM listings WHERE discovery_source=$1 AND external_place_id=$2 LIMIT 1',
      [source, p.id],
    );
    if (known.length) return false;
    const duplicateOf = await this.findNearby(p);
    // Only the Place ID, coordinates and our own operational fields are stored. displayName / types stay in memory.
    const draft = { discovery: { source, placeId: p.id, discoveredAt: new Date().toISOString(), lat: p.lat, lng: p.lng, destination, ...(p.hasPhone === true ? { hasPhone: true } : {}) } };
    // Our own derived location only (never Google text). Unknown destination / outside Himachal -> all NULL.
    const loc = deriveDiscoveredLocation(p.lat, p.lng, destination);
    const inserted = await this.ds.query(
      `INSERT INTO listings (host_id, status, is_discovered, discovery_source, external_place_id, discovered_at,
                             discovery_state, discovery_destination, discovery_category, discovery_duplicate_of, draft_data,
                             disc_district, disc_tehsil, disc_lat, disc_lng)
       VALUES (NULL, 'discovered', true, $1, $2, now(), 'DISCOVERED', $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
       ON CONFLICT (discovery_source, external_place_id) WHERE is_discovered DO NOTHING
       RETURNING id`,
      [source, p.id, destination, category, duplicateOf, JSON.stringify(draft),
        loc?.district ?? null, loc?.tehsil ?? null, loc?.lat ?? null, loc?.lng ?? null],
    );
    return inserted.length > 0;
  }

  /** Nearest live or discovered listing within DUPLICATE_DISTANCE_M, by coordinates only. */
  async findNearby(p: { lat: number; lng: number }): Promise<string | null> {
    const b = boundingBox(p, DUPLICATE_DISTANCE_M * 2);
    const num = (path: string) => `CASE WHEN (draft_data#>>'{${path}}') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (draft_data#>>'{${path}}')::float8 END`;
    const rows: { id: string; lat: number; lng: number }[] = await this.ds.query(
      `SELECT id, lat, lng FROM (
         SELECT id,
           COALESCE(${num('discovery,lat')}, ${num('property_details,lat')}) AS lat,
           COALESCE(${num('discovery,lng')}, ${num('property_details,lng')}) AS lng
         FROM listings WHERE status = 'live' OR is_discovered
       ) t WHERE lat BETWEEN $1 AND $2 AND lng BETWEEN $3 AND $4`,
      [b.minLat, b.maxLat, b.minLng, b.maxLng],
    );
    let best: { id: string; d: number } | null = null;
    for (const r of rows) {
      const d = haversineMetres(p, { lat: Number(r.lat), lng: Number(r.lng) });
      if (d < DUPLICATE_DISTANCE_M && (!best || d < best.d)) best = { id: r.id, d };
    }
    return best?.id ?? null;
  }
}
