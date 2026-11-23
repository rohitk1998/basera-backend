/** In-memory ledger_entries emulation: enforces on-conflict-do-nothing idempotency and group balance. */
export function fakeLedgerDb() {
  const rows: any[] = [];
  const query = jest.fn(async (sql: string, p: unknown[] = []) => {
    if (!/insert into ledger_entries/.test(sql)) throw new Error('unexpected sql: ' + sql.slice(0, 60));
    const out: any[] = [];
    for (let i = 0; i < p.length; i += 11) {
      const [booking_id, payment_id, entry_group, line_no, kind, idem_key, account, debit, credit, ref, meta] = p.slice(i, i + 11) as any[];
      if (rows.some((r) => r.idem_key === idem_key && r.line_no === line_no)) continue;
      const row = { booking_id, payment_id, entry_group, line_no, kind, idem_key, account, debit, credit, ref, meta: JSON.parse(meta) };
      rows.push(row);
      out.push({ id: rows.length });
    }
    return out;
  });
  const ds: any = { query, transaction: async (cb: any) => cb({ query }) };
  const balance = (account: string) => rows.filter((r) => r.account === account).reduce((s, r) => s + r.credit - r.debit, 0);
  const groupsBalanced = () => {
    const g = new Map<string, number>();
    for (const r of rows) g.set(r.entry_group, (g.get(r.entry_group) ?? 0) + r.debit - r.credit);
    return [...g.values()].every((v) => v === 0);
  };
  return { rows, ds, query, balance, groupsBalanced };
}
