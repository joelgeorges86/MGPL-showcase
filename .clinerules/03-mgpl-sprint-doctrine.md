# MGPL Sprint Doctrine & Database Telemetry (Vibe Coding Manual v5.0.3)

## 1. Multi-Source Library Ingestion (Chapter 21)
- **Unified Schema Mapping**: External sources (`steam`, `psn`, `gog`, `pc`, `manual`, `scan`) must preserve native `external_id` without inference.
- **Title Normalization**: Standardize casing and punctuation while maintaining original title integrity.
- **Background Cron Sync**: Fetch source deltas → stage → deduplicate (source ID first, fuzzy title fallback) → merge → queue enrichment → run playability updates.
- **Metadata Fallback Order**: Deterministic source metadata → Trusted public APIs → AI enrichment (labeled low confidence until human/source verified).

## 2. Specs Persistence Contract & State Management (Chapters 9.1 & 22)
- **Persisted Hardware Specs**: CPU (model/cores), RAM (size/class), GPU (model/VRAM/driver/role), Storage (type/free space/target), Battery/Thermal capabilities, scan timestamp, and device ID.
- **Anti-Stale Input Rule**: Full persisted specs must rehydrate from DB before calculating compatibility recommendations. UI state alone is NEVER authoritative.
- **Strict Extraction**: Do not infer VRAM from GPU name or total capacity alone. Unknown values MUST trigger clarification or scan retry.

## 3. Explicit Action Trigger Rule (Chapter 23)
- **Multi-Variable Threshold**: If a UI calculation depends on three or more independent state variables (specs, library metadata, ownership, platform, battery, thermals, filters), reactivity MUST be disabled.
- **Explicit User Action**: Recomputation must be triggered explicitly via user action (e.g., "Analyze", "Calculate Compatibility", "Refresh Matrix").
- **Graceful Failure UI**: Display blocked states ("Missing VRAM", "Refresh device scan required") rather than guessing or silently failing.

## 4. SQLite Schema Pitfalls & Live Debugging Protocol (Appendix D)
- **Raw SQL vs. Query Layer**: When UI behavior conflicts with the application's better-sqlite3 query layer, inspect raw SQLite rows directly via PRAGMA and targeted SELECT queries before modifying application logic.
- **Migration Verification**: Every schema-affecting WUD must verify migrations via `PRAGMA table_info(table_name)` and foreign key integrity checks.
- **Terminal Telemetry Protocol**: Capture failed SQL, stack traces, API payloads, and migration status into prompt packets for mechanical remediation (`deepseek-v4-flash`) or architectural analysis (`claude-sonnet-5`).
