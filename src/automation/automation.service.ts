import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { NotificationsService } from '../notifications/notifications.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { reminderDedupeKey } from './automation.buckets';
import { AUTOMATIONS, getAutomation, validateParams } from './automation.definitions';
import type { AutomationDef, AutomationParams, CandidateRow, PlannedReminder, RunSummary } from './automation.types';

export const GLOBAL_KIND = '_global';
const DRY_RUN_PREVIEW_CAP = 200;

export interface EffectiveSettings {
  enabled: boolean;
  params: AutomationParams;
}

@Injectable()
export class AutomationService {
  private readonly logger = new Logger(AutomationService.name);

  constructor(
    private readonly ds: DataSource,
    private readonly notifications: NotificationsService,
    @Optional() private readonly whatsapp?: WhatsappService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  private get appUrl(): string {
    return this.config?.get<string>('APP_URL') ?? 'https://www.rhenbasera.online';
  }

  // ---- settings ---------------------------------------------------------------------------------------------

  async isPaused(): Promise<boolean> {
    const rows = await this.ds.query(`SELECT params FROM automation_settings WHERE kind = $1`, [GLOBAL_KIND]);
    return rows[0]?.params?.paused === true;
  }

  async setPaused(paused: boolean, actor: string | null): Promise<{ paused: boolean }> {
    await this.ds.query(
      `INSERT INTO automation_settings (kind, enabled, params, updated_by, updated_at)
       VALUES ($1, true, jsonb_build_object('paused', $2::boolean), $3, now())
       ON CONFLICT (kind) DO UPDATE SET params = jsonb_build_object('paused', $2::boolean), updated_by = $3, updated_at = now()`,
      [GLOBAL_KIND, paused, actor],
    );
    return { paused };
  }

  /** Stored overrides merged over the code defaults (stored keys the spec no longer knows are dropped). */
  effective(def: AutomationDef, row?: { enabled: boolean; params: Record<string, unknown> }): EffectiveSettings {
    const params: AutomationParams = { ...def.defaultParams };
    for (const [k, v] of Object.entries(row?.params ?? {})) if (k in def.paramSpec) params[k] = v as any;
    return { enabled: row?.enabled ?? true, params };
  }

  async getSettings(kind: string): Promise<EffectiveSettings> {
    const def = this.mustGet(kind);
    const rows = await this.ds.query(`SELECT enabled, params FROM automation_settings WHERE kind = $1`, [kind]);
    return this.effective(def, rows[0]);
  }

  private mustGet(kind: string): AutomationDef {
    const def = getAutomation(kind);
    if (!def) throw new NotFoundException(`Unknown automation "${kind}"`);
    return def;
  }

  async update(kind: string, patch: { enabled?: boolean; params?: Record<string, unknown> }, actor: string | null) {
    const def = this.mustGet(kind);
    const current = await this.getSettings(kind);
    let params = current.params;
    if (patch.params) {
      const v = validateParams(def, patch.params);
      if (!v.ok) throw new BadRequestException(v.error);
      params = { ...params, ...v.params };
    }
    const enabled = patch.enabled ?? current.enabled;
    await this.ds.query(
      `INSERT INTO automation_settings (kind, enabled, params, updated_by, updated_at) VALUES ($1,$2,$3::jsonb,$4,now())
       ON CONFLICT (kind) DO UPDATE SET enabled = EXCLUDED.enabled, params = EXCLUDED.params, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [kind, enabled, JSON.stringify(params), actor],
    );
    return { kind, enabled, params };
  }

  async list() {
    const [settings, runs, counts, paused] = await Promise.all([
      this.ds.query(`SELECT kind, enabled, params FROM automation_settings`),
      this.ds.query(
        `SELECT DISTINCT ON (kind) kind, dry_run, started_at, finished_at, candidates, sent, skipped, error
           FROM automation_runs WHERE dry_run = false ORDER BY kind, started_at DESC`,
      ),
      this.ds.query(`SELECT kind, count(*)::int AS total, count(*) FILTER (WHERE sent_at > now() - interval '24 hours')::int AS last_24h FROM reminder_log GROUP BY kind`),
      this.isPaused(),
    ]);
    const byKind = <T extends { kind: string }>(rows: T[]) => new Map(rows.map((r) => [r.kind, r]));
    const s = byKind<any>(settings);
    const r = byKind<any>(runs);
    const c = byKind<any>(counts);
    return {
      paused,
      automations: AUTOMATIONS.map((def) => {
        const eff = this.effective(def, s.get(def.kind));
        return {
          kind: def.kind,
          title: def.title,
          description: def.description,
          audience: def.audience,
          enabled: eff.enabled,
          params: eff.params,
          paramSpec: def.paramSpec,
          lastRun: r.get(def.kind) ?? null,
          remindersSent: { total: c.get(def.kind)?.total ?? 0, last24h: c.get(def.kind)?.last_24h ?? 0 },
        };
      }),
    };
  }

  // ---- running ----------------------------------------------------------------------------------------------

  private async missingTables(tables: string[]): Promise<string[]> {
    const rows = await this.ds.query(
      `SELECT t, to_regclass('public.' || t) IS NOT NULL AS present FROM unnest($1::text[]) AS t`,
      [tables],
    );
    return rows.filter((r: any) => !r.present).map((r: any) => r.t);
  }

  private async adminIds(): Promise<string[]> {
    const rows = await this.ds.query(`SELECT id::text FROM users WHERE role = 'admin'`);
    return rows.map((r: any) => r.id);
  }

  private recipientsFor(def: AutomationDef, row: CandidateRow): 'admins' | string {
    if (def.audience === 'admin') return 'admins';
    return row.user_id ? String(row.user_id) : 'admins';
  }

  /** Run one automation. Safe to call concurrently: reminder_log's unique key arbitrates. */
  async run(kind: string, opts: { dryRun?: boolean; actor?: string | null; now?: Date; force?: boolean } = {}): Promise<RunSummary> {
    const def = this.mustGet(kind);
    const dryRun = !!opts.dryRun;
    const now = opts.now ?? new Date();
    const summary: RunSummary = { kind, dryRun, candidates: 0, sent: 0, alreadySent: 0, failed: 0, whatsappSent: 0, whatsappBlocked: 0 };

    if (!dryRun) {
      if (await this.isPaused()) return { ...summary, skippedReason: 'paused' };
      if (!opts.force && !(await this.getSettings(kind)).enabled) return { ...summary, skippedReason: 'disabled' };
    }
    const missing = await this.missingTables(def.requires);
    if (missing.length) return { ...summary, skippedReason: 'missing_tables', missingTables: missing };

    const { params } = await this.getSettings(kind);
    const runId = dryRun ? null : await this.startRun(kind, opts.actor ?? null);
    try {
      const q = def.query(params);
      const rows: CandidateRow[] = await this.ds.query(q.sql, [now.toISOString(), ...q.args]);
      const admins = rows.some((r) => this.recipientsFor(def, r) === 'admins') ? await this.adminIds() : [];
      const planned: PlannedReminder[] = [];

      for (const row of rows) {
        const bucket = def.bucket(row, params);
        if (!bucket) continue;
        summary.candidates++;
        const recipients = this.recipientsFor(def, row);
        const subjectId = String(row.subject_id);

        if (dryRun) {
          const existing = await this.ds.query(`SELECT 1 FROM reminder_log WHERE kind=$1 AND subject_id=$2 AND bucket=$3`, [kind, subjectId, bucket]);
          const alreadySent = existing.length > 0;
          if (alreadySent) summary.alreadySent++;
          if (planned.length < DRY_RUN_PREVIEW_CAP) planned.push({ subjectId, bucket, recipients, alreadySent, title: row.title ? String(row.title) : null });
          continue;
        }

        // Claim the slot first: the unique key makes concurrent runs/replicas send exactly once.
        const claim = await this.ds.query(
          `INSERT INTO reminder_log (kind, subject_type, subject_id, bucket) VALUES ($1,$2,$3,$4)
           ON CONFLICT (kind, subject_id, bucket) DO NOTHING RETURNING id`,
          [kind, def.subjectType, subjectId, bucket],
        );
        if (!claim.length) { summary.alreadySent++; continue; }

        const targets = recipients === 'admins' ? admins : [recipients];
        const dedupeKey = reminderDedupeKey(kind, subjectId, bucket);
        const data = def.data(row, params, this.appUrl);
        let delivered = 0;
        for (const uid of targets) {
          try {
            await this.notifications.dispatch(def.event as any, uid, data, { dedupeKey });
            delivered++;
          } catch (e: any) {
            this.logger.warn(`[${kind}] notify ${uid} failed: ${e?.message ?? e}`);
          }
        }
        if (targets.length === 0 || delivered === 0) {
          // Nothing went out: release the slot so the next sweep retries instead of silently dropping it.
          await this.ds.query(`DELETE FROM reminder_log WHERE kind=$1 AND subject_id=$2 AND bucket=$3`, [kind, subjectId, bucket]);
          summary.failed++;
          continue;
        }
        summary.sent++;
        await this.sendWhatsapp(def, row, params, summary);
      }
      if (dryRun) summary.wouldNotify = planned;
      if (runId) await this.finishRun(runId, summary, null);
      return summary;
    } catch (e: any) {
      if (runId) await this.finishRun(runId, summary, e?.message ?? String(e));
      throw e;
    }
  }

  /** WhatsApp is best effort on top of the in-app/email/push notification: blocked (no consent, no config) is normal. */
  private async sendWhatsapp(def: AutomationDef, row: CandidateRow, params: AutomationParams, summary: RunSummary): Promise<void> {
    if (!this.whatsapp || !def.whatsapp) return;
    const plan = def.whatsapp(row, params, this.appUrl);
    if (!plan || !row.phone) return;
    try {
      const out = await this.whatsapp.sendTemplate({
        to: String(row.phone), template: plan.template, params: plan.params, relatedType: def.subjectType, relatedId: String(row.subject_id),
      });
      if (out.status === 'blocked') summary.whatsappBlocked++; else summary.whatsappSent++;
    } catch (e: any) {
      summary.whatsappBlocked++;
      this.logger.warn(`[${def.kind}] whatsapp failed: ${e?.message ?? e}`);
    }
  }

  private async startRun(kind: string, actor: string | null): Promise<string> {
    const rows = await this.ds.query(`INSERT INTO automation_runs (kind, dry_run, triggered_by) VALUES ($1,false,$2) RETURNING id::text`, [kind, actor]);
    return rows[0].id;
  }

  private async finishRun(id: string, s: RunSummary, error: string | null): Promise<void> {
    await this.ds.query(
      `UPDATE automation_runs SET finished_at=now(), candidates=$2, sent=$3, skipped=$4, error=$5 WHERE id=$1`,
      [id, s.candidates, s.sent, s.alreadySent, error],
    );
  }

  /** Kinds the scheduler should enqueue now (enabled, not paused). */
  async enabledKinds(): Promise<string[]> {
    if (await this.isPaused()) return [];
    const rows = await this.ds.query(`SELECT kind FROM automation_settings WHERE enabled = false`);
    const off = new Set(rows.map((r: any) => r.kind));
    return AUTOMATIONS.map((a) => a.kind).filter((k) => !off.has(k));
  }
}
