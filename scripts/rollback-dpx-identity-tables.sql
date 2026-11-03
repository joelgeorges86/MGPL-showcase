-- Rollback for the AI-095 shared identity tables. Run only after the code that creates them is
-- reverted, otherwise initDb() recreates them (empty) at the next boot. Run it before
-- scripts/rollback-mobile-catalogue-tables.sql if both are ever needed; neither depends on the
-- other. Against production this is a production database change reserved to the Principal
-- Operator (AGENTS.md section 3).
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;
DROP INDEX IF EXISTS idx_dpx_evidence_subject;
DROP INDEX IF EXISTS idx_dpx_evidence_edition;
DROP INDEX IF EXISTS idx_dpx_evidence_store;
DROP INDEX IF EXISTS idx_dpx_evidence_hardware;
DROP INDEX IF EXISTS idx_dpx_evidence_mobile;
DROP TABLE IF EXISTS dpx_evidence_observations;
DROP INDEX IF EXISTS idx_dpx_references_model_code;
DROP INDEX IF EXISTS idx_dpx_references_scope;
DROP INDEX IF EXISTS idx_dpx_references_family;
DROP TABLE IF EXISTS dpx_hardware_references;
DROP TABLE IF EXISTS dpx_hardware_families;
DROP INDEX IF EXISTS idx_dpx_store_products_edition;
DROP TABLE IF EXISTS dpx_store_products;
DROP INDEX IF EXISTS idx_dpx_editions_work;
DROP TABLE IF EXISTS dpx_game_editions;
DROP INDEX IF EXISTS idx_dpx_work_links_wikidata;
DROP TABLE IF EXISTS dpx_work_links;
DROP TABLE IF EXISTS dpx_game_works;
DROP TABLE IF EXISTS dpx_import_batches;
COMMIT;
