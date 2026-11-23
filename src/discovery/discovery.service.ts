import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { CronTime } from 'cron';
import { DataSource } from 'typeorm';
import { SEARCH_CACHE_VERSION_KEY } from '../listings/listings.service';
import { RedisService } from '../redis/redis.service';
import { QueueService } from '../queue/queue.service';
import { DiscoveryUsageService } from './discovery-usage.service';
import { GooglePlacesClient } from './google-places.client';
import { canTransition, DISCOVERY_SOURCES, isDiscoveryState } from './discovery.constants';
import type { CreateJobDto, ListCandidatesDto, ListJobsDto, PutSettingsDto } from './discovery.dto';

const CANDIDATE_COLS = `id, discovery_source, external_place_id, discovered_at, discovery_state, discovery_destination,
  discovery_category, discovery_assigned_to, discovery_duplicate_of, claimed_at, claimed_by, status,
  draft_data#>>'{discovery,lat}' AS lat, draft_data#>>'{discovery,lng}' AS lng,
  draft_data#>>'{property_details,title}' AS title, draft_data#>'{admin_only,contact}' AS contact`;

/** States that remove a discovered row from the public /stays grid. */
const DISCOVERED_GRID_EXIT_STATES: readonly string[] = ['ARCHIVED', 'HOST_DECLINED', 'CONVERTED_TO_PROPERTY'];

export function validCron(expr: string): boolean {
  try {
    if (expr.trim().split(/\s+/).length !== 5) return false;
    new CronTime(expr, 'UTC');
    return true;
  } catch {
    return false;
  }
}

@Injectable()
export class DiscoveryService {
  constructor(
    private readonly ds: DataSource,
    private readonly queues: QueueService,
    private readonly usage: DiscoveryUsageService,
    private readonly client: GooglePlacesClient,
    @Optional() private readonly redis?: RedisService,
  ) {}

  // ---- settings ----
  listSettings() {
    return this.ds.query('SELECT * FROM discovery_settings ORDER BY destination');
  }

  async putSettings(destination: string, dto: PutSettingsDto, adminId: string) {
    const dest = destination.trim();
    if (dest.length < 2 || dest.length > 80) throw new BadRequestException('Invalid destination.');
    if (dto.schedule_cron && !validCron(dto.schedule_cron)) throw new BadRequestException('schedule_cron must be a valid 5-field cron expression.');
    const cron = dto.schedule_cron === undefined ? undefined : dto.schedule_cron || null;
    const rows = await this.ds.query(
      `INSERT INTO discovery_settings (destination, categories, max_new_per_run, daily_request_budget, schedule_cron, paused, updated_by)
       VALUES ($1, COALESCE($2::text[], ARRAY['homestay','cottage','guest house','resort']), COALESCE($3, 50), COALESCE($4, 100), $5, COALESCE($6, false), $7)
       ON CONFLICT (destination) DO UPDATE SET
         categories = COALESCE($2::text[], discovery_settings.categories),
         max_new_per_run = COALESCE($3, discovery_settings.max_new_per_run),
         daily_request_budget = COALESCE($4, discovery_settings.daily_request_budget),
         schedule_cron = CASE WHEN $8 THEN $5 ELSE discovery_settings.schedule_cron END,
         paused = COALESCE($6, discovery_settings.paused),
         updated_by = $7, updated_at = now()
       RETURNING *`,
      [dest, dto.categories ?? null, dto.max_new_per_run ?? null, dto.daily_request_budget ?? null, cron ?? null, dto.paused ?? null, adminId, cron !== undefined],
    );
    return rows[0];
  }

  // ---- jobs ----
  async createJob(dto: { destination: string; categories?: string[]; maxNew?: number; idempotencyKey?: string }, createdBy: string | null) {
    const dest = dto.destination.trim();
    const s = (await this.ds.query('SELECT categories, max_new_per_run FROM discovery_settings WHERE destination=$1', [dest]))[0];
    const cats = dto.categories?.length ? dto.categories : s?.categories;
    if (!cats?.length) throw new BadRequestException('No categories: pass categories or configure the destination first.');
    const key = dto.idempotencyKey ?? `manual:${randomUUID()}`;
    const rows = await this.ds.query(
      `INSERT INTO discovery_jobs (destination, categories, max_new, idempotency_key, created_by)
       VALUES ($1, $2::text[], $3, $4, $5) ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
      [dest, cats, dto.maxNew ?? s?.max_new_per_run ?? null, key, createdBy],
    );
    if (!rows.length) {
      const existing = (await this.ds.query('SELECT * FROM discovery_jobs WHERE idempotency_key=$1', [key]))[0];
      return { job: existing, created: false };
    }
    await this.enqueue(rows[0].id, `job:${rows[0].id}`);
    return { job: rows[0], created: true };
  }

  private async enqueue(jobId: string, key: string) {
    try {
      await this.queues.enqueue('discovery', 'discovery.run', { jobId }, { idempotencyKey: key });
    } catch (e: any) {
      await this.ds.query(`UPDATE discovery_jobs SET status='failed', error=$2, finished_at=now() WHERE id=$1`, [jobId, `enqueue failed: ${e?.message ?? e}`]);
      throw new ServiceUnavailableException('Job queue is unavailable (REDIS_URL?). The job was marked failed.');
    }
  }

  async runNow(destination: string, adminId: string) {
    const dest = destination.trim();
    const s = (await this.ds.query('SELECT 1 FROM discovery_settings WHERE destination=$1', [dest]))[0];
    if (!s) throw new NotFoundException('Unknown destination; save its settings first.');
    return this.createJob({ destination: dest }, adminId);
  }

  async listJobs(q: ListJobsDto) {
    const page = q.page ?? 1, size = q.pageSize ?? 20;
    const where = q.status ? 'WHERE status=$1' : '';
    const params: unknown[] = q.status ? [q.status] : [];
    const [{ count }] = await this.ds.query(`SELECT count(*)::int AS count FROM discovery_jobs ${where}`, params);
    const items = await this.ds.query(
      `SELECT * FROM discovery_jobs ${where} ORDER BY created_at DESC LIMIT ${size} OFFSET ${(page - 1) * size}`, params);
    return { items, total: count, page, pageSize: size };
  }

  async getJob(id: string) {
    const j = (await this.ds.query('SELECT * FROM discovery_jobs WHERE id=$1', [id]))[0];
    if (!j) throw new NotFoundException('Job not found.');
    return j;
  }

  private async moveJob(id: string, from: string[], to: string, what: string) {
    const rows = await this.ds.query(
      `UPDATE discovery_jobs SET status=$3, finished_at=CASE WHEN $3='cancelled' THEN now() ELSE finished_at END
        WHERE id=$1 AND status = ANY($2::text[]) RETURNING *`, [id, from, to]);
    if (rows.length) return rows[0];
    const j = await this.getJob(id);
    throw new ConflictException(`Cannot ${what} a job that is ${j.status}.`);
  }
  pauseJob(id: string) { return this.moveJob(id, ['queued', 'running'], 'paused', 'pause'); }
  cancelJob(id: string) { return this.moveJob(id, ['queued', 'running', 'paused'], 'cancelled', 'cancel'); }

  async resumeJob(id: string) {
    const job = await this.moveJob(id, ['paused', 'failed'], 'queued', 'resume');
    await this.ds.query(`UPDATE discovery_jobs SET error=NULL, finished_at=NULL WHERE id=$1`, [id]);
    await this.enqueue(id, `resume:${id}:${Date.now()}`);
    return { ...job, error: null };
  }

  // ---- candidates ----
  async listCandidates(q: ListCandidatesDto) {
    const page = q.page ?? 1, size = q.pageSize ?? 25;
    const w: string[] = ['is_discovered'];
    const p: unknown[] = [];
    const add = (cond: string, v: unknown) => { p.push(v); w.push(cond.replace('?', `$${p.length}`)); };
    if (q.destination) add('discovery_destination = ?', q.destination);
    if (q.state) add('discovery_state = ?', q.state);
    if (q.category) add('discovery_category = ?', q.category);
    if (q.assigned_to) add('discovery_assigned_to = ?', q.assigned_to);
    if (q.search) {
      p.push(`%${q.search.replace(/[%_\\]/g, '\\$&')}%`);
      const n = `$${p.length}`;
      w.push(`(external_place_id ILIKE ${n} OR discovery_destination ILIKE ${n} OR discovery_category ILIKE ${n})`);
    }
    const where = w.join(' AND ');
    const [{ count }] = await this.ds.query(`SELECT count(*)::int AS count FROM listings WHERE ${where}`, p);
    const items = await this.ds.query(
      `SELECT ${CANDIDATE_COLS} FROM listings WHERE ${where} ORDER BY discovered_at DESC, id LIMIT ${size} OFFSET ${(page - 1) * size}`, p);
    return { items, total: count, page, pageSize: size };
  }

  async candidateCounts(): Promise<{ destination: string; count: number }[]> {
    return this.ds.query(
      `SELECT discovery_destination AS destination, count(*)::int AS count
         FROM listings WHERE is_discovered AND discovery_destination IS NOT NULL
         GROUP BY discovery_destination`);
  }

  async getCandidate(id: string) {
    const r = (await this.ds.query(`SELECT ${CANDIDATE_COLS} FROM listings WHERE id=$1 AND is_discovered`, [id]))[0];
    if (!r) throw new NotFoundException('Candidate not found.');
    return r;
  }

  async transition(id: string, to: string, adminId: string, note?: string) {
    if (!isDiscoveryState(to)) throw new BadRequestException('Unknown state.');
    if (to === 'CONVERTED_TO_PROPERTY') throw new BadRequestException('CONVERTED_TO_PROPERTY is set only by the claim flow.');
    const cur = await this.getCandidate(id);
    if (!canTransition(cur.discovery_state, to)) {
      throw new ConflictException(`Cannot move a candidate from ${cur.discovery_state} to ${to}.`);
    }
    // Optimistic: the WHERE re-checks the state we validated against, so a concurrent change loses cleanly.
    const rows = await this.ds.query(
      `UPDATE listings SET discovery_state=$2, updated_at=now() WHERE id=$1 AND is_discovered AND discovery_state=$3 RETURNING id`,
      [id, to, cur.discovery_state]);
    if (!rows.length) throw new ConflictException('The candidate changed concurrently; reload and retry.');
    void adminId; void note;
    if (DISCOVERED_GRID_EXIT_STATES.includes(to)) {
      try { await this.redis?.incrementVersion(SEARCH_CACHE_VERSION_KEY); } catch { /* cache is best-effort; TTL covers it */ }
    }
    return this.getCandidate(id);
  }

  async assign(id: string, userId: string | null) {
    await this.getCandidate(id);
    if (userId) {
      const u = (await this.ds.query(`SELECT 1 FROM users WHERE id=$1 AND role='admin'`, [userId]))[0];
      if (!u) throw new BadRequestException('assigned_to must be a staff (admin) user.');
    }
    await this.ds.query(`UPDATE listings SET discovery_assigned_to=$2, updated_at=now() WHERE id=$1 AND is_discovered`, [id, userId]);
    return this.getCandidate(id);
  }

  async markDuplicate(id: string, duplicateOf: string, adminId: string) {
    if (id === duplicateOf) throw new BadRequestException('A candidate cannot duplicate itself.');
    const exists = (await this.ds.query('SELECT 1 FROM listings WHERE id=$1', [duplicateOf]))[0];
    if (!exists) throw new BadRequestException('duplicate_of does not exist.');
    const cur = await this.getCandidate(id);
    await this.ds.query(`UPDATE listings SET discovery_duplicate_of=$2, updated_at=now() WHERE id=$1 AND is_discovered`, [id, duplicateOf]);
    if (cur.discovery_state !== 'ARCHIVED') await this.transition(id, 'ARCHIVED', adminId, 'duplicate');
    return this.getCandidate(id);
  }

  archive(id: string, adminId: string) {
    return this.transition(id, 'ARCHIVED', adminId, 'archived');
  }

  // ---- observability ----
  async apiUsage(days = 14) {
    const errors = await this.ds.query(
      `SELECT id, destination, status, error, finished_at FROM discovery_jobs WHERE error IS NOT NULL ORDER BY created_at DESC LIMIT 20`);
    return {
      integration: { source: this.client.sourceKey, blocked: this.client.blockedReason(), dryRun: this.client.dryRun },
      usage: await this.usage.usage(days),
      recentJobErrors: errors,
    };
  }

  listSources() {
    return DISCOVERY_SOURCES;
  }
}
