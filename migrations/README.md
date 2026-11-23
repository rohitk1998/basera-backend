# Migrations

Plain SQL, forward-only, applied by `scripts/migrate.mjs` (nothing runs automatically on app start).

## Rules
- File name: `YYYYMMDD_snake_case.sql`. Applied in lexical order.
- Idempotent (`IF NOT EXISTS`, guarded `DO` blocks). `npm run lint:migrations` enforces the basics; `-- lint:allow` on a statement is the escape hatch, with a reason.
- Never edit an applied file: the runner stores sha256 and refuses to continue if it changes. Add a new file.
- Each file runs in ONE transaction: do not put `CREATE INDEX CONCURRENTLY` (or other non-transactional statements) in a file; run those by hand and record them.
- Files may contain their own BEGIN/COMMIT only if unavoidable; the runner already wraps them.

## Commands (need SUPABASE_DB_* in env/.env)
    npm run migrate:status                        # ledger vs disk (read-only)
    npm run migrate:dry                           # list what would run (read-only)
    npm run migrate:apply                         # needs --yes already baked in
    NODE_ENV=production npm run migrate:apply -- --allow-production

## First use on an existing database (baseline)
Everything dated before 20261122 was applied by hand. Record them without running:
    node scripts/migrate.mjs --baseline-existing --dry-run
    node scripts/migrate.mjs --baseline-existing --yes
CAUTION: this includes the six 20261121_* files. Confirm they really are applied (tables/columns exist)
before baselining; if any is not, run it by hand first or delete its ledger row after baselining.
Then `migrate:status` should show 0 pending; new files (20261122+) apply normally.

## Down files
`migrations/down/<name>.down.sql`, run by hand, never by the runner. Exist for 20261121_*;
20261122_* and later authors add their own (drop only what you created, IF EXISTS, comment data loss).
Rollback notes for risky changes go in `scripts/rollback-notes/<name>.md`.
