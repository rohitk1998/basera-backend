-- Rollback for 20261122_claims_property_claims.sql. Destructive: run only deliberately.
DROP TABLE IF EXISTS property_members, claim_disputes, claim_events, claim_evidence, property_claims CASCADE;
DROP FUNCTION IF EXISTS claim_events_append_only();
-- Bucket 'claim-evidence' is left in place (empty it via the storage API first, then delete manually).
