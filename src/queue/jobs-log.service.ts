import { Injectable, Logger, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';

export type JobLogState = 'active' | 'completed' | 'failed' | 'dead';

export interface JobLogRow {
  id: string;
  job_id: string;
  queue: string;
  name: string;
  attempts: number;
  state: JobLogState;
  started_at: string;
  finished_at: string | null;
  error: string | null;
}

/** Best-effort audit trail in jobs_log. A logging failure must never fail or retry a job. */
@Injectable()
export class JobsLogService {
  private readonly logger = new Logger(JobsLogService.name);

  constructor(@Optional() private readonly ds?: DataSource) {}

  private async run(sql: string, params: unknown[]): Promise<void> {
    if (!this.ds) return;
    try {
      await this.ds.query(sql, params);
    } catch (e: any) {
      this.logger.warn(`jobs_log write failed: ${e?.message ?? e}`);
    }
  }

  started(queue: string, jobId: string, name: string, attempts: number): Promise<void> {
    return this.run(
      `INSERT INTO jobs_log (job_id, queue, name, attempts, state, started_at)
       VALUES ($1,$2,$3,$4,'active',now())
       ON CONFLICT (queue, job_id) DO UPDATE
         SET attempts = EXCLUDED.attempts, state = 'active', started_at = now(), finished_at = NULL, error = NULL`,
      [jobId, queue, name, attempts],
    );
  }

  completed(queue: string, jobId: string): Promise<void> {
    return this.run(`UPDATE jobs_log SET state='completed', finished_at=now(), error=NULL WHERE queue=$1 AND job_id=$2`, [queue, jobId]);
  }

  failed(queue: string, jobId: string, name: string, attempts: number, error: string, dead: boolean): Promise<void> {
    return this.run(
      `INSERT INTO jobs_log (job_id, queue, name, attempts, state, started_at, finished_at, error)
       VALUES ($1,$2,$3,$4,$5,now(),now(),$6)
       ON CONFLICT (queue, job_id) DO UPDATE
         SET attempts = EXCLUDED.attempts, state = EXCLUDED.state, finished_at = now(), error = EXCLUDED.error`,
      [jobId, queue, name, attempts, dead ? 'dead' : 'failed', error.slice(0, 2000)],
    );
  }

  async list(f: { state?: string; queue?: string; limit: number; offset: number }): Promise<{ items: JobLogRow[]; total: number }> {
    if (!this.ds) return { items: [], total: 0 };
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.state) { params.push(f.state); where.push(`state = $${params.length}`); }
    if (f.queue) { params.push(f.queue); where.push(`queue = $${params.length}`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number((await this.ds.query(`SELECT count(*)::int AS n FROM jobs_log ${w}`, params))[0].n);
    const items = await this.ds.query(
      `SELECT id::text, job_id, queue, name, attempts, state, started_at, finished_at, error
         FROM jobs_log ${w} ORDER BY started_at DESC, id DESC LIMIT ${Number(f.limit)} OFFSET ${Number(f.offset)}`,
      params,
    );
    return { items, total };
  }

  async get(id: string): Promise<JobLogRow | null> {
    if (!this.ds) return null;
    const rows = await this.ds.query(
      `SELECT id::text, job_id, queue, name, attempts, state, started_at, finished_at, error FROM jobs_log WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }
}
