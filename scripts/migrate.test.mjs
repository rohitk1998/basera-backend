import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { sha256, listMigrationNames, baselineSet, plan, guardProduction } from './migrate.mjs';

test('sha256 is stable and content-sensitive', () => {
  assert.equal(sha256('a'), sha256('a'));
  assert.notEqual(sha256('a'), sha256('a '));
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('listMigrationNames filters and sorts lexically', () => {
  assert.deepEqual(
    listMigrationNames(['20261122_b.sql', 'down', 'README.md', '20260101_a.sql', '20261121_z.sql']),
    ['20260101_a.sql', '20261121_z.sql', '20261122_b.sql'],
  );
});

test('baselineSet takes only files dated before 20261122', () => {
  assert.deepEqual(baselineSet(['20261121_x.sql', '20261122_y.sql', '20270101_z.sql']), ['20261121_x.sql']);
});

test('real migrations dir: every existing file is baselined, down/ ignored', () => {
  const names = listMigrationNames(readdirSync(new URL('../migrations', import.meta.url)));
  assert.ok(names.length > 30);
  assert.equal(baselineSet(names).length, names.filter((n) => n < '20261122').length);
});

test('plan detects pending, applied, changed, missing', () => {
  const files = [{ filename: 'a', sha256: '1' }, { filename: 'b', sha256: '2' }, { filename: 'c', sha256: '3' }];
  const ledger = [{ filename: 'a', sha256: '1' }, { filename: 'b', sha256: 'X' }, { filename: 'gone', sha256: '9' }];
  const p = plan(files, ledger);
  assert.deepEqual(p.applied.map((f) => f.filename), ['a']);
  assert.deepEqual(p.changed.map((f) => f.filename), ['b']);
  assert.deepEqual(p.pending.map((f) => f.filename), ['c']);
  assert.deepEqual(p.missing, ['gone']);
});

test('guardProduction', () => {
  assert.ok(guardProduction({ NODE_ENV: 'production' }, new Set(['--yes'])));
  assert.equal(guardProduction({ NODE_ENV: 'production' }, new Set(['--allow-production'])), null);
  assert.equal(guardProduction({}, new Set()), null);
});
