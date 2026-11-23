-- Licence rules now live in code (DISCOVERY_SOURCES in src/discovery/discovery.constants.ts); nothing reads the table.
DROP TABLE IF EXISTS discovery_sources; -- lint:allow table is unused; user approved the drop
