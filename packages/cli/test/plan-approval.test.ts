import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ManualTaskInput, PlanningInput, PlanningResult, Project } from "@agentic-dev-runner/core";
import { createSqliteRunnerStore } from "@agentic-dev-runner/persistence";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import { createStoreBackedAppService } from "../src/application/store-backed-app-service.js";
import { writePlanDraft } from "../src/application/planning/plan-files.js";

const input: PlanningInput = {
  repositoryRoot: "/repo", goal: "Build a TODO app", baseRevision: "abc123",
  repositoryEvidence: [], knownDecisions: [], answeredQuestionIds: [], existingTaskIds: [],
};
const result: PlanningResult = {
  version: 1, kind: "READY_FOR_PLANNING",
  milestones: [{ id: "M1", title: "Core", completionCriteria: ["Tasks can be added"] }],
  tasks: [{ id: "T1" }],
};

function task(id = "T1", dependsOn: readonly string[] = []): ManualTaskInput {
  return {
    id, title: "Add a task", milestone: "M1", status: "READY", priority: "P0", risk: "low",
    type: "implementation", objective: "Add tasks", acceptanceCriteria: ["Task is saved"],
    dependsOn, provenance: { kind: "roadmap_criterion", source: "M1" },
    scope: { allowedPaths: ["src/**"], forbiddenPaths: [] }, resources: [], workflow: "simple",
    routing: { complexity: "small", capabilities: [] }, verification: { required: [] },
    limits: { maxAttempts: 3, maxReviewCycles: 2 }, approval: { required: false },
  };
}

type Fixture = {
  root: string;
  store: RunnerStore;
  service: ReturnType<typeof createStoreBackedAppService>;
  makeDraft(tasks?: readonly ManualTaskInput[], draftInput?: PlanningInput): Promise<string>;
  cleanup(): Promise<void>;
};

async function fixture(storeOverride?: (store: RunnerStore) => RunnerStore): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "agentic-plan-approval-"));
  const store = createSqliteRunnerStore({ path: join(root, "state.db") });
  await store.initialize();
  const project: Project = {
    id: "proj-local", name: "fixture", rootPath: root,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
  await store.putProject(project);
  const service = createStoreBackedAppService({
    storePath: join(root, "state.db"), projectRoot: root, store: storeOverride?.(store) ?? store,
    orchestrator: {} as never, recovery: { async reconcileUnfinished() { return []; }, async reconcileTask() { return { kind: "no-op", taskId: "T1", detail: "test" }; } } as never, agents: {} as never,
    configuration: { verificationChecks: [], agentProfiles: [] },
  });
  return {
    root, store, service,
    async makeDraft(tasks = [task()], draftInput = input) {
      if (result.kind !== "READY_FOR_PLANNING") throw new Error("fixture result must be ready");
      const draftResult: PlanningResult = { ...result, tasks: tasks.map((item) => ({ id: item.id })) };
      return (await writePlanDraft(root, draftInput, draftResult, tasks)).planId;
    },
    async cleanup() { await store.close(); await rm(root, { recursive: true, force: true }); },
  };
}

const fixtures: Fixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((item) => item.cleanup()));
});

async function newFixture(storeOverride?: (store: RunnerStore) => RunnerStore): Promise<Fixture> {
  const item = await fixture(storeOverride);
  fixtures.push(item);
  return item;
}

describe("plan approval", () => {
  it("imports no tasks until explicit approval", async () => {
    const setup = await newFixture();
    const planId = await setup.makeDraft([task("T1"), task("T2")]);
    expect((await setup.service.showPlan!(planId))?.approvalStatus).toBe("draft");
    expect(await setup.store.listTasks()).toEqual([]);
    expect(await setup.service.approvePlan!(planId)).toMatchObject({ kind: "approved", planId, taskIds: ["T1", "T2"] });
    expect((await setup.service.showPlan!(planId))?.approvalStatus).toBe("approved");
    expect((await setup.store.getTask("T1"))?.title).toBe("Add a task");
    expect((await setup.store.getTask("T2"))?.title).toBe("Add a task");
    expect(await setup.store.listEvents({ type: "plan.approved" })).toHaveLength(1);
    const draftPath = join(setup.root, ".agentic", "plans", planId, "plan.json");
    const edited = JSON.parse(await readFile(draftPath, "utf8")) as { tasks: Record<string, unknown>[] };
    edited.tasks[0] = { ...edited.tasks[0], title: "Edited after approval" };
    await (await import("node:fs/promises")).writeFile(draftPath, JSON.stringify(edited), "utf8");
    expect((await setup.service.showPlan!(planId))?.approvalStatus).toBe("changed");
    expect((await setup.service.approvePlan!(planId)).kind).toBe("rejected");
  });

  it("rejects invalid edits and duplicate task IDs without importing anything", async () => {
    const setup = await newFixture();
    const planId = await setup.makeDraft([task("T1"), { ...task("T1"), title: "Duplicate" }]);
    const outcome = await setup.service.approvePlan!(planId);
    expect(outcome.kind).toBe("rejected");
    expect(await setup.store.listTasks()).toEqual([]);
    expect(await setup.store.listEvents({ type: "plan.approved" })).toEqual([]);
  });

  it("rejects dependencies that disappeared from runner state after planning", async () => {
    const setup = await newFixture();
    const planId = await setup.makeDraft([task("T2", ["MISSING"])], { ...input, existingTaskIds: ["MISSING"] });
    const outcome = await setup.service.approvePlan!(planId);
    expect(outcome.kind).toBe("rejected");
    expect(outcome.message).toContain('depends on missing runner task "MISSING"');
    expect(await setup.store.listTasks()).toEqual([]);
    expect(await setup.store.listEvents({ type: "plan.approved" })).toEqual([]);
  });

  it("rejects task ID collisions with runner state", async () => {
    const setup = await newFixture();
    const planId = await setup.makeDraft();
    await setup.store.putTask({
      id: "T1", projectId: "proj-local", title: "Existing", milestone: "M1", status: "READY",
      type: "implementation", priority: "P0", risk: "low", definition: {
        objective: "Existing task", acceptanceCriteria: ["Exists"], scope: { allowedPaths: ["src/**"], forbiddenPaths: [] },
        resources: [], verification: { required: [] }, limits: { maxAttempts: 3, maxReviewCycles: 2 }, approval: { required: false },
      }, routing: { complexity: "small", capabilities: [] }, provenance: { kind: "user_request", source: "fixture" },
      dependsOn: [], workflow: "simple", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect((await setup.service.approvePlan!(planId)).kind).toBe("rejected");
    expect(await setup.store.listEvents({ type: "plan.approved" })).toEqual([]);
  });

  it("rolls back task writes when the approval event cannot be recorded", async () => {
    const setup = await newFixture((store) => new Proxy(store, {
      get(target, property) {
        if (property === "appendEvents") return async () => { throw new Error("event write failed"); };
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }));
    const planId = await setup.makeDraft([task("T1"), task("T2")]);
    await expect(setup.service.approvePlan!(planId)).rejects.toThrow("event write failed");
    expect(await setup.store.listTasks()).toEqual([]);
    expect(await setup.store.listEvents({ type: "plan.approved" })).toEqual([]);
    await expect(readFile(join(setup.root, ".agentic", "plans", planId, "approved.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses the durable approval event without a fallible marker projection", async () => {
    const setup = await newFixture();
    const planId = await setup.makeDraft();
    await setup.service.approvePlan!(planId);
    const markerPath = join(setup.root, ".agentic", "plans", planId, "approved.json");
    await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await setup.service.approvePlan!(planId)).kind).toBe("rejected");
    await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await setup.store.listTasks()).toHaveLength(1);
    expect(await setup.store.listEvents({ type: "plan.approved" })).toHaveLength(1);
    
  });
});
