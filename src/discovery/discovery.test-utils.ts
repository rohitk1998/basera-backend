import { GooglePlacesClient } from './google-places.client';

export function fakeUsage(initial = 0) {
  const u = { count: initial, errors: [] as string[], reserve: jest.fn(async (_s: string, budget: number) => (u.count < budget ? (u.count++, true) : false)), recordError: jest.fn(async (_s: string, m: string) => { u.errors.push(m); }) };
  return u;
}

export function makeClient(env: Record<string, string>, usage = fakeUsage(), deps: any = {}) {
  const config = { get: (k: string) => env[k] } as any;
  return { client: new GooglePlacesClient(usage as any, config, deps), usage };
}

/** In-memory stand-in for the raw SQL the runner issues (matched by statement shape). */
export class FakeDs {
  jobs = new Map<string, any>();
  listings: any[] = [];
  settings: any = { max_new_per_run: 50, daily_request_budget: 100 };
  onPageDone?: (jobId: string) => void;

  addJob(over: Partial<any> = {}) {
    const j = { id: 'job-1', destination: 'Manali', categories: ['homestay'], status: 'queued', requests_used: 0, new_count: 0, duplicate_count: 0, max_new: null, error: null, started_at: null, finished_at: null, ...over };
    this.jobs.set(j.id, j);
    return j;
  }

  async query(sql: string, p: any[] = []): Promise<any[]> {
    const s = sql.replace(/\s+/g, ' ').trim();
    const job = this.jobs.get(p[0]);
    if (s.startsWith('SELECT * FROM discovery_jobs WHERE id')) return job ? [{ ...job }] : [];
    if (s.startsWith('SELECT status FROM discovery_jobs')) return job ? [{ status: job.status }] : [];
    if (s.startsWith("UPDATE discovery_jobs SET status='running'")) { job.status = 'running'; return []; }
    if (s.startsWith('SELECT max_new_per_run')) return [this.settings];
    if (s.startsWith('UPDATE discovery_jobs SET status=$2, error=$3')) { Object.assign(job, { status: p[1], error: p[2] }); return []; }
    if (s.includes("status='paused', error=$2")) { if (job.status === 'running') Object.assign(job, { status: 'paused', error: p[1], requests_used: p[2], new_count: p[3], duplicate_count: p[4] }); return []; }
    if (s.startsWith('UPDATE discovery_jobs SET requests_used=$2')) {
      if (s.includes("status='running'") && job.status !== 'running') return [];
      Object.assign(job, { requests_used: p[1], new_count: p[2], duplicate_count: p[3] });
      this.onPageDone?.(job.id);
      return [];
    }
    if (s.startsWith('SELECT 1 FROM listings WHERE discovery_source')) return this.listings.filter((l) => l.discovery_source === p[0] && l.external_place_id === p[1]).slice(0, 1);
    if (s.startsWith('SELECT id, lat, lng FROM')) return this.listings.filter((l) => l.lat >= p[0] && l.lat <= p[1] && l.lng >= p[2] && l.lng <= p[3]);
    if (s.startsWith('INSERT INTO listings')) {
      if (this.listings.some((l) => l.is_discovered && l.discovery_source === p[0] && l.external_place_id === p[1])) return [];
      const d = JSON.parse(p[5]).discovery;
      const row = { id: `l-${this.listings.length + 1}`, is_discovered: true, status: 'discovered', discovery_source: p[0], external_place_id: p[1], discovery_destination: p[2], discovery_category: p[3], discovery_duplicate_of: p[4], draft_data: JSON.parse(p[5]), lat: d.lat, lng: d.lng, disc_district: p[6], disc_tehsil: p[7], disc_lat: p[8], disc_lng: p[9], insertParams: p };
      this.listings.push(row);
      return [{ id: row.id }];
    }
    throw new Error(`FakeDs: unhandled SQL ${s.slice(0, 80)}`);
  }
}
