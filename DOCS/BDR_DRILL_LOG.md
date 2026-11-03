# MGPL Backup and Disaster-Recovery Drill Log

PI-004 restore drills use `scripts/staging-restore-drill.sh` and an isolated path under
`data/recovery-drills/`. The runner refuses the live staging, production, and test database names.

Each generated record under `DOCS/evidence/` includes the source replica, requested and observed
recovery point, restore start and finish, measured RTO and RPO, integrity and foreign-key results,
representative row counts, isolated application smoke results, anomalies, and Principal Operator sign-off.

| Drill UTC  | Outcome                | Findings                                                                                                                                                                                                  | Source       | Recovery point | RTO          | RPO          | Integrity    | Smoke        | Operator decision | Evidence                                                                    |
| ---------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------------- | ------------ | ------------ | ------------ | ------------ | ----------------- | --------------------------------------------------------------------------- |
| 2026-09-23 | Completed successfully | App did not exit on SIGTERM before Docker's timeout; tracked in [#90](https://github.com/joelgeorges86/MGPL/issues/90). Reconciliation tracked in [#89](https://github.com/joelgeorges86/MGPL/issues/89). | Not recorded | Not recorded   | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded      | [G-3 restore drill evidence](research/G3-restore-drill-20260923T201532Z.md) |

## Evidence location recommendation

**Recommendation for operator decision:** keep restore-drill evidence under `DOCS/research/` as the repository convention. The G-3 artifact is already recorded there, while `DOCS/evidence/` and `data/recovery-drills/` were introduced by `fde3977` and have never been populated. Do not delete or move either empty directory in this change; confirm separately whether either directory has an intended future consumer before removing it.

Never enter credentials, access keys, session tokens, private account data, or production database
contents in this log.
