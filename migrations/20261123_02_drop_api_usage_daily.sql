-- Usage counters moved to Redis (src/discovery/discovery-usage.service.ts). Counters were throw-away operational data.
DROP TABLE IF EXISTS api_usage_daily; -- lint:allow table is unused; user approved the drop
