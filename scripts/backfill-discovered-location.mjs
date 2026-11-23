#!/usr/bin/env node
// Backfill disc_district/disc_tehsil/disc_lat/disc_lng on discovered (google_places) rows.
// Offline: no Google calls. Needs `npm run build` (loads dist/listings/discovered-location.util.js).
//   node scripts/backfill-discovered-location.mjs          # dry run (default)
//   node scripts/backfill-discovered-location.mjs --yes    # write
// Safe to re-run (only rows with disc_lat IS NULL). Same env vars as scripts/migrate.mjs.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BATCH = 500;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Pure: the UPDATE for one row. Only touches disc_* on is_discovered rows. loc=null means outside HP (all NULL). */
export function buildUpdate(row, loc) {
  return {
    sql: 'UPDATE listings SET disc_district=$2,disc_tehsil=$3,disc_lat=$4,disc_lng=$5 WHERE id=$1 AND is_discovered AND disc_lat IS NULL',
    params: [row.id, loc ? loc.district : null, loc ? loc.tehsil : null, loc ? loc.lat : null, loc ? loc.lng : null],
  };
}

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

async function main() {
  const write = process.argv.includes('--yes');
  const utilPath = path.join(SCRIPT_DIR, '..', 'dist', 'listings', 'discovered-location.util.js');
  if (!existsSync(utilPath)) { console.error('dist/listings/discovered-location.util.js not found: run npm run build first'); process.exit(1); }
  const { deriveDiscoveredLocation } = await import(pathToFileURL(utilPath).href);
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
  let updated = 0, noCoords = 0, outsideHp = 0, lastId = null;
  try {
    for (;;) {
      const { rows } = await client.query(
        `SELECT id, draft_data->'discovery'->>'lat' AS lat, draft_data->'discovery'->>'lng' AS lng, discovery_destination
           FROM listings
          WHERE is_discovered AND discovery_source='google_places' AND disc_lat IS NULL
            AND ($1::uuid IS NULL OR id > $1::uuid)
          ORDER BY id LIMIT ${BATCH}`,
        [lastId],
      );
      if (!rows.length) break;
      lastId = rows[rows.length - 1].id;
      const updates = [];
      for (const r of rows) {
        const lat = num(r.lat), lng = num(r.lng);
        if (lat === null || lng === null || !Number.isFinite(lat) || !Number.isFinite(lng)) { noCoords++; continue; }
        const loc = deriveDiscoveredLocation(lat, lng, r.discovery_destination);
        if (!loc) outsideHp++;
        updates.push(buildUpdate(r, loc));
      }
      if (write && updates.length) {
        await client.query('BEGIN');
        try {
          for (const u of updates) await client.query(u.sql, u.params);
          await client.query('COMMIT');
        } catch (e) { await client.query('ROLLBACK'); throw e; }
      }
      updated += updates.length;
    }
  } finally { await client.end(); }
  console.log(`${write ? 'WROTE' : 'DRY RUN (pass --yes to write)'}: updated=${updated} (of which outside HP=${outsideHp}) no-coords=${noCoords}`);
  console.log('Reminder: bump the Redis key `listings:search:version` so /stays caches pick this up.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
