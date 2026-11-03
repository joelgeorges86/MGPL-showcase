# Definition of Done (DoD) & Quality Gate SOP

DEFINITION OF DONE (DoD) & QUALITY GATE SOP:
Under no circumstances shall any feature (FEAT-XXXX) or bugfix be declared 'Complete' or ready for completion until ALL of the following gates pass with ZERO errors, in order:

1. **TypeScript Verification**: `npx tsc --noEmit` — 0 TypeScript errors.
2. **Client JS Syntax Validation**: `npm run test:client` — all non-bundled vanilla client scripts in `public/*.js` parse cleanly.
3. **Spell Check**: `npm run test:spell` — 0 CSpell issues. Add any new legitimate technical, hardware, storefront, or third-party terms to `cspell.json` rather than ignoring failures (e.g. Fanatical, Gamesplanet, GameBillet, LPDDR5, headroomRating, sparklines, Retrode, GBxCart, Wasm, bestStoreType, UWP, Denuvo).
4. **Unit Tests**: `npm run test:unit` — full Vitest unit suite passes.
5. **Playwright E2E Suite**: `npx playwright test --workers=1` — full E2E suite passes. ALWAYS run with `--workers=1` (parallel workers cause `SQLITE_BUSY` lock contention against the shared test database and produce false failures). Assertions must prefer resilient visibility and state checks over brittle timing assumptions.
6. **Full Gate Suite**: `gates/run-all.sh` — S1–S4 security and Q1–Q5 quality gates, 0 blocking findings.

If new UI components or user flows were added during the task, a corresponding Playwright test file (or test case in existing spec) MUST be authored and verified passing before task sign-off.

**Deployment rule (authoritative — see `AGENTS.md` §5):** a passing gate chain does NOT authorize pushing to `main`. Work lands on a `feature/*` branch and goes through a PR; promotion to `main` is performed exclusively by the Principal Operator. **No agent commits directly to `main`, and no agent merges to `main`, ever.**

## State Persistence Contract (Chapter 22.6 / Appendix D.4)
Any new SQLite persistence table (e.g. AppGameTags, AppGameNotes, AppPriceAlerts, AppWishlist, AppRetroTracking) MUST be registered in `src/routes/state.ts` for JSON backup export/import round-tripping. A migration is incomplete until backup and restore behavior has been verified via `PRAGMA table_info(table_name)` and foreign key integrity checks.
