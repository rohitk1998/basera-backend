#!/usr/bin/env node
// Lints migrations/*.sql for non-idempotent or destructive patterns.
// Escape hatch: put `-- lint:allow` on the offending statement's line (or anywhere in a statement).
// Usage: node scripts/lint-migrations.mjs [--since YYYYMMDD]   (default: every file)
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Split into statements, ignoring ; inside $$ bodies, quotes and comments. Keeps comments for the allow marker. */
export function splitStatements(sql) {
  const out = [];
  let cur = '', i = 0, inDollar = null;
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (inDollar) {
      if (rest.startsWith(inDollar)) { cur += inDollar; i += inDollar.length; inDollar = null; } else { cur += sql[i++]; }
      continue;
    }
    const d = rest.match(/^\$[A-Za-z_]*\$/);
    if (d) { inDollar = d[0]; cur += d[0]; i += d[0].length; continue; }
    if (rest.startsWith('--')) { const e = rest.indexOf('\n'); const t = e === -1 ? rest : rest.slice(0, e); cur += t; i += t.length; continue; }
    if (sql[i] === "'") { let j = i + 1; while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" ? 2 : 1; cur += sql.slice(i, j + 1); i = j + 1; continue; }
    if (sql[i] === ';') { i++; const m = sql.slice(i).match(/^[ \t]*--[^\n]*/); if (m) { cur += m[0]; i += m[0].length; } out.push(cur); cur = ''; continue; }
    cur += sql[i++];
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const stripComments = (s) => s.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');

export function lintSql(sql) {
  const problems = [];
  for (const raw of splitStatements(sql)) {
    if (/--\s*lint:allow/.test(raw)) continue;
    const s = stripComments(raw).replace(/\s+/g, ' ').trim();
    if (!s || /^(begin|commit)$/i.test(s)) continue;
    // Statements inside DO $$ blocks are guarded by their own logic; only judge the top level.
    const top = s.replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, '$$$$');
    const head = top.slice(0, 120);
    if (/^create table (?!if not exists)/i.test(top)) problems.push(`CREATE TABLE without IF NOT EXISTS: ${head}`);
    if (/^create (unique )?index (?!if not exists)/i.test(top)) problems.push(`CREATE INDEX without IF NOT EXISTS: ${head}`);
    if (/^drop table/i.test(top)) problems.push(`DROP TABLE: ${head}`);
    if (/^truncate/i.test(top)) problems.push(`TRUNCATE: ${head}`);
    if (/^delete from/i.test(top) && !/\bwhere\b/i.test(top)) problems.push(`DELETE without WHERE: ${head}`);
  }
  return problems;
}

function main() {
  const si = process.argv.indexOf('--since');
  const since = si > -1 ? process.argv[si + 1] : '00000000';
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  let bad = 0;
  for (const f of readdirSync(dir).filter((n) => /^\d{8}_.+\.sql$/.test(n) && n.slice(0, 8) >= since).sort()) {
    for (const p of lintSql(readFileSync(path.join(dir, f), 'utf8'))) { console.error(`${f}: ${p}`); bad++; }
  }
  if (bad) { console.error(`\n${bad} problem(s). Fix, or add "-- lint:allow" with a reason.`); process.exit(1); }
  console.log('migrations lint: ok');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
