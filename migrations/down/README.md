# Down migrations

Convention: `migrations/down/<same-name>.down.sql` pairs with `migrations/<same-name>.sql`.
The runner never executes these; apply by hand (psql) after reading them, ideally on a restored copy first.
Down files are written for 20261121_* (below). Authors of 20261122_* and later migrations add their own.
Each drops only what its forward migration created, guarded with IF EXISTS, and flags data loss in comments.
