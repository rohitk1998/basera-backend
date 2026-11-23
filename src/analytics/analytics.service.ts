import { BadRequestException, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RedisService } from '../redis/redis.service';
import { METRICS, MetricResult, MetricSpec, SECTIONS, Section, metricsFor, toResult, unavailable } from './analytics.metrics';
import { Window, WindowError, resolveWindow } from './analytics.window';

export const ANALYTICS_CACHE_TTL_S = 60;

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    private readonly ds: DataSource,
    @Optional() private readonly redis?: RedisService,
  ) {}

  window(from?: string, to?: string): Window {
    try {
      return resolveWindow(from, to);
    } catch (e) {
      if (e instanceof WindowError) throw new BadRequestException(e.message);
      throw e;
    }
  }

  private async existing(tables: string[]): Promise<Set<string>> {
    const rows = await this.ds.query(`SELECT t, to_regclass('public.' || t) IS NOT NULL AS present FROM unnest($1::text[]) AS t`, [tables]);
    return new Set(rows.filter((r: any) => r.present).map((r: any) => r.t));
  }

  /** Run one metric; a missing source table or a failing query yields value null, never an exception. */
  async computeMetric(spec: MetricSpec, w: Window, present: Set<string>): Promise<MetricResult> {
    const missing = spec.requires.filter((t) => !present.has(t));
    if (missing.length) return unavailable(spec, 'missing_tables', missing);
    try {
      const rows = await this.ds.query(spec.build(), [w.from.toISOString(), w.to.toISOString()]);
      return toResult(spec, rows[0]);
    } catch (e: any) {
      this.logger.warn(`metric ${spec.key} failed: ${e?.message ?? e}`);
      return unavailable(spec, 'error');
    }
  }

  async section(section: Section, from?: string, to?: string, refresh = false) {
    const w = this.window(from, to);
    const key = `analytics:${section}:${w.from.toISOString()}:${w.to.toISOString()}`;
    if (!refresh && this.redis) {
      const hit = await this.redis.get(key);
      if (hit) {
        try { return { ...JSON.parse(hit), cached: true }; } catch { /* fall through and recompute */ }
      }
    }
    const specs = metricsFor(section);
    const present = await this.existing([...new Set(specs.flatMap((s) => s.requires))]);
    const metrics = await Promise.all(specs.map((s) => this.computeMetric(s, w, present)));
    const body = {
      section,
      window: { from: w.from.toISOString(), to: w.to.toISOString() },
      generatedAt: new Date().toISOString(),
      metrics: Object.fromEntries(metrics.map((m) => [m.key, m])),
    };
    if (this.redis) await this.redis.set(key, JSON.stringify(body), ANALYTICS_CACHE_TTL_S);
    return { ...body, cached: false };
  }

  async overview(from?: string, to?: string, refresh = false) {
    const sections = await Promise.all(SECTIONS.map((s) => this.section(s, from, to, refresh)));
    return Object.fromEntries(sections.map((s) => [s.section, s]));
  }

  definitions() {
    return METRICS.map((m) => ({ key: m.key, section: m.section, label: m.label, unit: m.unit, requires: m.requires, ...m.definition }));
  }

  // ---- manual acquisition spend -------------------------------------------------------------------------------

  private async costsTable(): Promise<void> {
    if (!(await this.existing(['acquisition_costs'])).has('acquisition_costs')) {
      throw new ServiceUnavailableException('acquisition_costs table is missing: apply migrations/20261122_automation_queue_jobs.sql');
    }
  }

  async listCosts() {
    await this.costsTable();
    return this.ds.query(
      `SELECT id::text, period, amount_rupees AS "amountRupees", note, created_by::text AS "createdBy", created_at AS "createdAt"
         FROM acquisition_costs ORDER BY period DESC, created_at DESC LIMIT 200`,
    );
  }

  async addCost(input: { period: string; amountRupees: number; note?: string }, actor: string | null) {
    await this.costsTable();
    const rows = await this.ds.query(
      `INSERT INTO acquisition_costs (period, amount_rupees, note, created_by) VALUES ($1,$2,$3,$4)
       RETURNING id::text, period, amount_rupees AS "amountRupees", note, created_at AS "createdAt"`,
      [input.period, input.amountRupees, input.note ?? null, actor],
    );
    return rows[0];
  }
}
