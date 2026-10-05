### Task 2: Build bounded repository analysis input

**Files:**
- Create: `packages/cli/src/application/planning/repository-analysis.ts`
- Create: `packages/cli/test/repository-analysis.test.ts`
- Modify: `packages/cli/src/application/app-services.ts`

**Interfaces:**
- Consumes: `PlanningInput` from Task 1 and existing `GitManager.resolveHeadRevision/status`.
- Produces: `analyzeRepository(projectRoot, goal?, existingTaskIds) -> Promise<PlanningInput>`; deterministic evidence records for required docs, root/one-level manifests, capped tracked path listing, tests, and `.agentic/decisions.md`.

- [ ] Add temp-repository tests for established, empty, missing-file, dirty-tree, size-limit, and stable-order cases.
- [ ] Run `pnpm --filter @agentic-dev-runner/cli exec vitest run test/repository-analysis.test.ts` and confirm failure.
- [ ] Implement bounded local scanning with Node filesystem APIs and existing Git state; record missing optional files as absent and cap aggregate bytes and path count.
- [ ] Run the focused test and confirm it passes.

