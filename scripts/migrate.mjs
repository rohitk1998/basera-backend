#!/usr/bin/env node
// Forward-only SQL migration runner (plain node + pg).
//
//   node scripts/migrate.mjs --status
//   node scripts/migrate.mjs --dry-run
//   node scripts/migrate.mjs --yes                          # apply pending
//   node scripts/migrate.mjs --baseline-existing --yes      # record pre-20261122 files as applied, run nothing
//   NODE_ENV=production ... --yes --allow-production
//
// Ledger: schema_migrations(filename, sha256, applied_at). Each file runs in its own transaction.
// A previously applied file whose sha256 changed aborts the run (never edit applied migrations).
// Pure helpers are exported for scripts/migrate.test.mjs; the CLI only runs when executed directly.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const BASELINE_CUTOFF = '20261122';
export const LEDGER_DDL = `create table if not exists schema_migrations (
  filename   text primary key,
  sha256     text not null,
  applied_at timestamptz not null default now()
)`;

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** Migration files: top-level *.sql only (down/ is excluded), lexical order. */
export function listMigrationNames(names) {
  return names.filter((n) => /^\d{8}_.+\.sql$/.test(n)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function datePrefix(filename) {
  return filename.slice(0, 8);
}

/** Files dated strictly before the cutoff (YYYYMMDD string compare). */
export function baselineSet(filenames, cutoff = BASELINE_CUTOFF) {
  return filenames.filter((f) => datePrefix(f) < cutoff);
}

/**
 * files: [{filename, sha256}], ledger: [{filename, sha256}]
 * -> { pending, applied, changed (applied but hash differs), missing (in ledger, not on disk) }
 */
export function plan(files, ledger) {
  const byName = new Map(ledger.map((r) => [r.filename, r.sha256]));
  const pending = [], applied = [], changed = [];
  for (const f of files) {
    if (!byName.has(f.filename)) pending.push(f);
    else if (byName.get(f.filename) !== f.sha256) changed.push(f);
    else applied.push(f);
  }
  const onDisk = new Set(files.map((f) => f.filename));
  const missing = ledger.filter((r) => !onDisk.has(r.filename)).map((r) => r.filename);
  return { pending, applied, changed, missing };
}

/** Returns a refusal message or null. */
export function guardProduction(env, flags) {
  if (env.NODE_ENV === 'production' && !flags.has('--allow-production')) {
    return 'NODE_ENV=production: refusing to run without --allow-production.';
  }
  return null;
}

function loadFiles(dir) {
  return listMigrationNames(readdirSync(dir)).map((filename) => {
    const sql = readFileSync(path.join(dir, filename), 'utf8');
    return { filename, sql, sha256: sha256(sql) };
  });
}

async function main(argv) {
  const flags = new Set(argv);
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  const files = loadFiles(dir);
  const mutating = flags.has('--yes');
  const dry = flags.has('--dry-run');
  const status = flags.has('--status');
  const baseline = flags.has('--baseline-existing');

  if (!dry && !status && !mutating) {
    console.error('Nothing to do. Use --status, --dry-run, or --yes (apply).');
    return 2;
  }
  if (mutating) {
    const refusal = guardProduction(process.env, flags);
    if (refusal) { console.error(refusal); return 2; }
  }

  const [{ default: pg }, dotenv] = await Promise.all([import('pg'), import('dotenv')]);
  dotenv.config();
  const client = new pg.Client({
    host: process.env.SUPABASE_DB_HOST,
    port: Number(process.env.SUPABASE_DB_PORT),
    user: process.env.SUPABASE_DB_USER,
    password: process.env.SUPABASE_DB_PASSWORD,
    database: process.env.SUPABASE_DB_NAME,
    ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const readOnly = (dry || status) && !mutating;
    // Read-only modes must not create the ledger: tolerate its absence.
    if (!readOnly) await client.query(LEDGER_DDL);
    let ledger = [];
    try {
      ledger = (await client.query('select filename, sha256 from schema_migrations')).rows;
    } catch (e) {
      if (e.code !== '42P01' || !readOnly) throw e;
    }
    const { pending, applied, changed, missing } = plan(files, ledger);

    if (status) {
      console.log(`applied: ${applied.length}  pending: ${pending.length}  changed: ${changed.length}  missing-on-disk: ${missing.length}`);
      for (const f of pending) console.log(`  pending  ${f.filename}`);
      for (const f of changed) console.log(`  CHANGED  ${f.filename}`);
      for (const f of missing) console.log(`  MISSING  ${f}`);
      return changed.length ? 1 : 0;
    }
    if (changed.length) {
      console.error('Refusing: applied migration(s) were modified (sha256 mismatch):');
      for (const f of changed) console.error(`  ${f.filename}`);
      console.error('Add a new migration instead of editing an applied one.');
      return 1;
    }

    if (baseline) {
      const toRecord = baselineSet(pending.map((f) => f.filename));
      if (dry) { console.log(`Would baseline ${toRecord.length} file(s) without running them:`); toRecord.forEach((f) => console.log(`  ${f}`)); return 0; }
      for (const f of files.filter((x) => toRecord.includes(x.filename))) {
        await client.query('insert into schema_migrations (filename, sha256) values ($1, $2) on conflict do nothing', [f.filename, f.sha256]);
      }
      console.log(`Baselined ${toRecord.length} file(s) (not executed).`);
      return 0;
    }

    if (dry) {
      console.log(pending.length ? `Would apply ${pending.length} migration(s) in order:` : 'Nothing pending.');
      pending.forEach((f) => console.log(`  ${f.filename}`));
      return 0;
    }
    for (const f of pending) {
      console.log(`applying ${f.filename} ...`);
      try {
        await client.query('begin');
        await client.query(f.sql);
        await client.query('insert into schema_migrations (filename, sha256) values ($1, $2)', [f.filename, f.sha256]);
        await client.query('commit');
      } catch (e) {
        await client.query('rollback').catch(() => {});
        console.error(`FAILED ${f.filename}: ${e.message}`);
        return 1;
      }
    }
    console.log(`Applied ${pending.length} migration(s).`);
    return 0;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e.message); process.exit(1); });
}
