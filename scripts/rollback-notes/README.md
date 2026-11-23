# Rollback notes
One file per risky migration, named like the migration (`<name>.md`): what to do if it must be undone,
data that cannot be recovered, and the order of app-vs-schema rollback. Prefer `migrations/down/` where a pure SQL undo exists.
Before any production migration: take a Supabase backup / note the PITR timestamp (see audit/OPERATIONS_RUNBOOK.md).
