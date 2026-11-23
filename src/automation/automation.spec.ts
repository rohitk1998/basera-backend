import { ageBucket, minThreshold, reminderDedupeKey } from './automation.buckets';
import { AUTOMATIONS, AUTOMATION_KINDS, getAutomation, validateParams } from './automation.definitions';
import { AutomationService, GLOBAL_KIND } from './automation.service';

describe('bucketing', () => {
  it('returns the largest crossed threshold, null below the first', () => {
    expect(ageBucket(10, [72, 168])).toBeNull();
    expect(ageBucket(72, [72, 168])).toBe('h72');
    expect(ageBucket(100, [168, 72])).toBe('h72');
    expect(ageBucket(200, [72, 168])).toBe('h168');
    expect(ageBucket(NaN, [1])).toBeNull();
    expect(minThreshold([168, 72])).toBe(72);
  });
  it('dedupe key is stable per slot', () => {
    expect(reminderDedupeKey('k', 's', 'h72')).toBe(reminderDedupeKey('k', 's', 'h72'));
    expect(reminderDedupeKey('k', 's', 'h72')).not.toBe(reminderDedupeKey('k', 's', 'h168'));
  });
});

describe('definitions', () => {
  it('kinds are unique, SQL is read-only and parametrised on now ($1)', () => {
    expect(new Set(AUTOMATION_KINDS).size).toBe(AUTOMATION_KINDS.length);
    for (const def of AUTOMATIONS) {
      const q = def.query(def.defaultParams);
      expect(q.sql).toMatch(/^\s*SELECT/i);
      expect(q.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i);
      expect(q.sql).toContain('$1');
      const max = Math.max(...[...q.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
      expect(max).toBe(q.args.length + 1);
    }
  });
  it('booking automations never write bookings', () => {
    for (const k of ['booking_checkin_instructions', 'booking_checkout_reminder', 'booking_review_request', 'payment_reminder']) {
      expect(getAutomation(k)!.query(getAutomation(k)!.defaultParams).sql).not.toMatch(/UPDATE\s+bookings|INSERT\s+INTO\s+bookings/i);
    }
  });
  it('the removed alternative-suggestion automation is gone and no definition targets the removed event', () => {
    expect(AUTOMATION_KINDS).not.toContain('inquiry_alternative_suggestion');
    expect(getAutomation('inquiry_alternative_suggestion')).toBeUndefined();
    for (const def of AUTOMATIONS) {
      expect(def.event).not.toBe('admin.inquiry_suggest_alternatives');
      expect(def.query(def.defaultParams).sql).not.toMatch(/inquiry_alternatives/);
    }
  });
  it('inquiry_response_due still targets live inquiry states only', () => {
    const q = getAutomation('inquiry_response_due')!.query(getAutomation('inquiry_response_due')!.defaultParams);
    expect(q.sql).toMatch(/inquiries/);
    expect(q.sql).not.toMatch(/UPDATE|INSERT/i);
  });
  it('offer_expiring requires booking_offers (table-exists guard)', () => {
    expect(getAutomation('offer_expiring')!.requires).toContain('booking_offers');
  });
  it('age bucketing honours the 3/7 day, 2 day and 24h rules', () => {
    const p = (k: string) => getAutomation(k)!.defaultParams;
    const b = (k: string, age: number) => getAutomation(k)!.bucket({ subject_id: 'x', age_hours: age }, p(k));
    expect(b('claim_draft_incomplete', 71)).toBeNull();
    expect(b('claim_draft_incomplete', 73)).toBe('h72');
    expect(b('claim_more_info', 49)).toBe('h48');
    expect(b('claim_review_waiting', 49)).toBe('h48');
    expect(b('verification_review_alert', 25)).toBe('h24');
    expect(b('inquiry_unassigned', 2.5)).toBe('h2');
    expect(b('host_invited_not_onboarded', 169)).toBe('h168');
  });
  it('validates tuned params', () => {
    const d = getAutomation('claim_draft_incomplete')!;
    expect(validateParams(d, { thresholdsHours: [96, 24] })).toEqual({ ok: true, params: { thresholdsHours: [24, 96] } });
    expect(validateParams(d, { thresholdsHours: [] }).ok).toBe(false);
    expect(validateParams(d, { nope: 1 }).ok).toBe(false);
    expect(validateParams(d, { whatsapp: 'yes' }).ok).toBe(false);
    expect(validateParams(d, { maxPerRun: 99999 }).ok).toBe(false);
  });
});

/** Minimal in-memory DataSource double keyed on SQL fragments. */
function fakeDs(opts: { rows: any[]; paused?: boolean; missing?: string[]; enabled?: boolean }) {
  const log = new Set<string>();
  const calls: string[] = [];
  const query = jest.fn(async (sql: string, args: any[] = []) => {
    calls.push(sql);
    if (sql.includes('FROM automation_settings WHERE kind = $1') && args[0] === GLOBAL_KIND) return opts.paused ? [{ params: { paused: true } }] : [];
    if (sql.includes('FROM automation_settings WHERE kind = $1')) return opts.enabled === false ? [{ enabled: false, params: {} }] : [];
    if (sql.includes('to_regclass')) return (args[0] as string[]).map((t) => ({ t, present: !(opts.missing ?? []).includes(t) }));
    if (sql.includes("role = 'admin'")) return [{ id: 'admin-1' }, { id: 'admin-2' }];
    if (sql.startsWith('INSERT INTO automation_runs')) return [{ id: '1' }];
    if (sql.startsWith('UPDATE automation_runs')) return [];
    if (sql.startsWith('INSERT INTO reminder_log')) {
      const k = `${args[0]}|${args[2]}|${args[3]}`;
      if (log.has(k)) return [];
      log.add(k);
      return [{ id: 1 }];
    }
    if (sql.startsWith('DELETE FROM reminder_log')) { log.delete(`${args[0]}|${args[1]}|${args[2]}`); return []; }
    if (sql.startsWith('SELECT 1 FROM reminder_log')) return log.has(`${args[0]}|${args[1]}|${args[2]}`) ? [{}] : [];
    return opts.rows; // the definition's candidate query
  });
  return { ds: { query } as any, log, calls };
}

describe('AutomationService.run', () => {
  const row = (id: string, age = 80) => ({ subject_id: id, user_id: `u-${id}`, age_hours: age, title: 'Cabin', phone: '+919999999999', name: 'Asha' });
  const mk = (ds: any, dispatch = jest.fn(async () => [{ channel: 'in_app', status: 'sent' }]), sendTemplate = jest.fn(async () => ({ status: 'blocked', reason: 'blocked: no consent' }))) =>
    ({ svc: new AutomationService(ds, { dispatch } as any, { sendTemplate } as any), dispatch, sendTemplate });

  it('sends once per bucket and is idempotent across reruns', async () => {
    const { ds } = fakeDs({ rows: [row('c1')] });
    const { svc, dispatch } = mk(ds);
    const first = await svc.run('claim_draft_incomplete');
    expect(first).toMatchObject({ candidates: 1, sent: 1, alreadySent: 0 });
    expect(dispatch).toHaveBeenCalledWith('claim.draft_reminder', 'u-c1', expect.any(Object), { dedupeKey: 'automation:claim_draft_incomplete:c1:h72' });
    const second = await svc.run('claim_draft_incomplete');
    expect(second).toMatchObject({ candidates: 1, sent: 0, alreadySent: 1 });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('a later threshold is a new bucket and fires again', async () => {
    const r = fakeDs({ rows: [row('c1', 200)] });
    r.log.add('claim_draft_incomplete|c1|h72'); // the 3-day reminder already went out
    const { svc, dispatch } = mk(r.ds);
    expect((await svc.run('claim_draft_incomplete')).sent).toBe(1);
    expect(dispatch).toHaveBeenCalledWith(expect.anything(), 'u-c1', expect.anything(), { dedupeKey: 'automation:claim_draft_incomplete:c1:h168' });
    expect(r.log.has('claim_draft_incomplete|c1|h168')).toBe(true);
  });

  it('dry-run lists who would be notified and writes/sends nothing', async () => {
    const f = fakeDs({ rows: [row('c1'), row('c2')] });
    f.log.add('claim_draft_incomplete|c2|h72');
    const { svc, dispatch, sendTemplate } = mk(f.ds);
    const r = await svc.run('claim_draft_incomplete', { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.wouldNotify).toEqual([
      { subjectId: 'c1', bucket: 'h72', recipients: 'u-c1', alreadySent: false, title: 'Cabin' },
      { subjectId: 'c2', bucket: 'h72', recipients: 'u-c2', alreadySent: true, title: 'Cabin' },
    ]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(f.calls.some((s) => /^(INSERT|UPDATE|DELETE)/.test(s))).toBe(false);
  });

  it('is skipped while paused (even forced) but dry-run still works', async () => {
    const { svc, dispatch } = mk(fakeDs({ rows: [row('c1')], paused: true }).ds);
    expect((await svc.run('claim_draft_incomplete', { force: true })).skippedReason).toBe('paused');
    expect((await svc.run('claim_draft_incomplete', { dryRun: true })).candidates).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('is skipped when disabled unless forced (run-now)', async () => {
    const { svc, dispatch } = mk(fakeDs({ rows: [row('c1')], enabled: false }).ds);
    expect((await svc.run('claim_draft_incomplete')).skippedReason).toBe('disabled');
    expect((await svc.run('claim_draft_incomplete', { force: true })).sent).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('skips (does not fail) when a required table is missing', async () => {
    const { svc } = mk(fakeDs({ rows: [], missing: ['booking_offers'] }).ds);
    expect(await svc.run('offer_expiring')).toMatchObject({ skippedReason: 'missing_tables', missingTables: ['booking_offers'] });
  });

  it('releases the slot when delivery fails so the next sweep retries', async () => {
    const f = fakeDs({ rows: [row('c1')] });
    const { svc } = mk(f.ds, jest.fn(async () => { throw new Error('smtp down'); }));
    const r = await svc.run('claim_draft_incomplete');
    expect(r).toMatchObject({ sent: 0, failed: 1 });
    expect(f.log.size).toBe(0);
  });

  it('admin audience fans out to every admin with one reminder slot', async () => {
    const f = fakeDs({ rows: [{ subject_id: 'q1', age_hours: 50, title: 'Cabin' }] });
    const { svc, dispatch } = mk(f.ds);
    const r = await svc.run('claim_review_waiting');
    expect(r.sent).toBe(1);
    expect(dispatch.mock.calls.map((c: any[]) => c[1])).toEqual(['admin-1', 'admin-2']);
    expect(f.log.size).toBe(1);
  });

  it('whatsapp goes through WhatsappService; blocked is counted, not fatal', async () => {
    const { svc, sendTemplate } = mk(fakeDs({ rows: [row('c1')] }).ds);
    const r = await svc.run('claim_draft_incomplete');
    expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ template: 'claim_reminder', to: '+919999999999' }));
    expect(r).toMatchObject({ sent: 1, whatsappBlocked: 1, whatsappSent: 0 });
  });
});
