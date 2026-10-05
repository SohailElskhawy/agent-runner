### Task 1: Add provider-independent planning contracts and planner configuration

**Files:**
- Create: `packages/core/src/domain/planning-input.ts`
- Modify: `packages/core/src/domain/project-config.ts`
- Modify: `packages/core/src/domain/agent-profile.ts`
- Modify: `packages/core/src/domain/index.ts`
- Modify: `packages/config/src/project-config-file.ts`
- Test: `packages/core/test/planning-input.test.ts`
- Test: `packages/core/test/project-config.test.ts`
- Test: `packages/config/test/project-config-file.test.ts`

**Interfaces:**
- Produces: `PlanningInput` with `goal`, `baseRevision`, ordered repository evidence, known decisions, and existing task IDs; `ProjectConfiguration.planningProfileId` for the configured planning profile.

- [ ] Add tests for valid and malformed `PlanningInput`, including empty repositories and preserved deterministic evidence order.
- [ ] Run `pnpm --filter @agentic-dev-runner/core exec vitest run test/planning-input.test.ts test/project-config.test.ts` and confirm the new cases fail.
- [ ] Implement the smallest provider-free contract; parse `planning.profile` as a required non-empty profile id only when planning is invoked, preserving old config compatibility when the section is absent.
- [ ] Add config tests for absent/valid/unknown planner profile references and invalid values.
- [ ] Run the focused core and config tests; both must pass.

