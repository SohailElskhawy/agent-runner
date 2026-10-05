# Cheap-First Routing Task 3 Report

- Added `routeTaskAttempt` as the shared application helper for single-task and scheduler execution.
- The helper reads persisted attempts, applies the same failed-attempt tier floor used by scheduler admission, resolves an available capable profile, and records one `task.routing.decided` event per routing decision. Total attempts still enforce `maxAttempts`; only `FAILED` and `TIMED_OUT` attempts escalate the tier.
- Below-minimum-tier failures include the candidate and required tiers in diagnostics. Event reasons identify the risk/complexity floor or the tier increase after N failures.
- Red check: the new helper tests initially failed because the helper was missing; initial path runs also exposed old no-event expectations and a CLI boundary assertion tied to the old direct call.
- Green verification after review fixes: core routing tests (22 passed), coordinator tests (11 passed), CLI routing and workflow E2E (20 passed); core, orchestrator, and CLI typechecks; `git diff --check`.
- No dependencies or persistence schema changes.
