/**
 * Not picked up by the default `npm test` (jest rootDir is src/). Run with:
 *   npx jest --rootDir . scripts/backfill-discovered-location.spec.ts
 * The script is ESM (.mjs, import.meta), so it is exercised in a child node process; nothing here touches a database.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const SCRIPT = path.join(__dirname, 'backfill-discovered-location.mjs');

function buildUpdate(row: unknown, loc: unknown): { sql: string; params: unknown[] } {
  const code = `import { buildUpdate } from ${JSON.stringify('file://' + SCRIPT)};
    process.stdout.write(JSON.stringify(buildUpdate(${JSON.stringify(row)}, ${JSON.stringify(loc)})));`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } }));
}

describe('backfill-discovered-location buildUpdate', () => {
  const row = { id: 'abc', lat: '32.2', lng: '77.1', discovery_destination: 'Manali' };

  it('writes only the four disc_* columns, keyed by id', () => {
    const u = buildUpdate(row, { district: 'Kullu', tehsil: 'Manali', lat: 32.2, lng: 77.1 });
    expect(u.params).toEqual(['abc', 'Kullu', 'Manali', 32.2, 77.1]);
    const set = /SET (.+) WHERE/i.exec(u.sql)![1];
    expect(set.split(',').map((c) => c.split('=')[0].trim()).sort()).toEqual(['disc_district', 'disc_lat', 'disc_lng', 'disc_tehsil']);
  });

  it('only ever touches discovered rows that have not been backfilled', () => {
    const { sql } = buildUpdate(row, null);
    expect(sql).toMatch(/^UPDATE listings SET /);
    expect(sql).toMatch(/WHERE id=\$1 AND is_discovered AND disc_lat IS NULL$/);
    expect(sql).not.toMatch(/draft_data|status|host_id|claimed_at|DELETE|INSERT/i);
  });

  it('an outside-HP row (no location) gets all-NULL values', () => {
    expect(buildUpdate(row, null).params).toEqual(['abc', null, null, null, null]);
  });

  it('a district-only location keeps tehsil NULL', () => {
    expect(buildUpdate(row, { district: 'Shimla', tehsil: null, lat: 31.1, lng: 77.2 }).params).toEqual(['abc', 'Shimla', null, 31.1, 77.2]);
  });

  it('importing the module does not connect to anything or run main()', () => {
    expect(() => buildUpdate(row, null)).not.toThrow();
  });
});
