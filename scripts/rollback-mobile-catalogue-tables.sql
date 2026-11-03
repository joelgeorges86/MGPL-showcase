-- Rollback for the mobile staging tables. Run only after the code that creates them is reverted,
-- otherwise initDb() recreates them (empty) at the next boot. Against production this is a
-- production database change reserved to the Principal Operator (AGENTS.md section 3).
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;
DROP TABLE IF EXISTS mobile_listing_observations;
DROP TABLE IF EXISTS mobile_observations;
DROP TABLE IF EXISTS mobile_variant_sightings;
DROP TABLE IF EXISTS mobile_device_variants;
DROP INDEX IF EXISTS idx_mobile_references_model_code;
DROP INDEX IF EXISTS idx_mobile_references_source_scope;
DROP INDEX IF EXISTS idx_mobile_references_family;
DROP TABLE IF EXISTS mobile_hardware_references;
DROP TABLE IF EXISTS mobile_device_families;
DROP TABLE IF EXISTS mobile_sources;
DROP TABLE IF EXISTS mobile_import_batches;
COMMIT;
