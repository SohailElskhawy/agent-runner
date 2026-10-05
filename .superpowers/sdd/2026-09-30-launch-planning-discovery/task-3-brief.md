### Task 3: Parse planner results and assess readiness

**Files:**
- Create: `packages/core/src/domain/planning-result.ts`
- Create: `packages/core/src/domain/readiness.ts`
- Modify: `packages/core/src/domain/index.ts`
- Create: `packages/core/test/planning-result.test.ts`
- Create: `packages/core/test/readiness.test.ts`

**Interfaces:**
- Produces: version-1 discriminated result for `NEEDS_DISCOVERY` questions or `READY_FOR_PLANNING` milestones/tasks; pure validation returning all issues.

- [ ] Add tests for both result variants, unknown version/kind, malformed/empty questions, missing choices, milestone completion criteria, answered questions not repeating, and a defined project that can plan without low-risk implementation questions.
- [ ] Run the two focused core tests and confirm new cases fail.
- [ ] Implement typed parsing and inspectable readiness reasons; ensure low-risk reversible details do not block readiness.
- [ ] Run the focused tests and confirm they pass.

