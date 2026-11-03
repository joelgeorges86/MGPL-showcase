# Full-Stack State Persistence & Export/Import Contract (Vibe Coding Manual v5.0.4, Chapters 22 & Appendix D.4)

## 1. Database Is Authoritative
- UI state alone is NEVER authoritative. The database is authoritative; the UI must rehydrate from persisted specs before computing recommendations.
- Partial submissions must not overwrite validated persisted specs.
- Unknown properties must be stored as unknown, not guessed.

## 2. Application Persistence Tables
- `AppGameTags`: id, gameId, tagName, colorHex, createdAt; UNIQUE(gameId, tagName).
- `AppGameNotes`: id, gameId, noteMarkdown, updatedAt; UNIQUE(gameId).
- `AppPriceAlerts`: id, gameId, title, targetPrice, currentPrice, historicalLow, isTriggered, updatedAt; UNIQUE(gameId).
- `AppWishlist`: id, gameId, title, coverImage, targetPrice, currentBestPrice, bestStore, bestStoreType, historicalLow, isTriggered, notes.
- `AppRetroTracking`: retro preservation tracking state.

## 3. State Export/Import Registration (Chapter 22.6 / Appendix D.4)
- Every newly added persistence table MUST be registered in `src/routes/state.ts` so automated JSON snapshot export and restoration cycles include the full application state.
- A migration is incomplete until backup and restore behavior has been verified via `PRAGMA table_info(table_name)` and foreign key integrity checks.
- Backup validation must prove that all state tables round-trip through JSON snapshot export and restore without loss, duplication, or broken uniqueness constraints.
