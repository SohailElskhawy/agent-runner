import { describe, expect, it } from "vitest";
import type { RunnerAppService } from "../src/application/runner-app-service.js";
import { executeAnalyzeCommand, executePlanCommand, executePlanShowCommand } from "../src/commands/execute-commands.js";
import { runCli } from "../src/run-cli.js";
import { captureIo } from "./fixtures.js";

const input = {
  repositoryRoot: "/repo", goal: "Build a TODO app", baseRevision: "abc123",
  repositoryEvidence: [
    { path: "AGENTS.md", status: "present" as const, content: "Use TypeScript." },
    { path: "docs/ROADMAP.md", status: "absent" as const },
  ], knownDecisions: [], answeredQuestionIds: [], existingTaskIds: [],
};

function service(overrides: Record<string, unknown> = {}): RunnerAppService {
  return {
    analyze: async () => input,
    plan: async () => ({ kind: "NEEDS_DISCOVERY", questions: [{ id: "storage", prompt: "Where should tasks persist?", reason: "Persistence is important.", importance: "important", choices: ["Browser", "SQLite"] }] }),
    showPlan: async () => ({
      planId: "plan-0123456789abcdef", inputDigest: "sha256", summary: "# Build a TODO app",
      milestones: [{ id: "M1", title: "Core", completionCriteria: ["Tasks persist"] }],
      tasks: [{ id: "T1", title: "Add task form", milestone: "M1", dependsOn: [], approvalRequired: false, objective: "Create an item", acceptanceCriteria: ["Item appears"], allowedPaths: ["src/**"], risk: "low" }],
      parallelizableTaskCount: 1,
      approvalStatus: "draft",
      conflicts: [
        { kind: "path", taskIdA: "T1", taskIdB: "T2", patterns: [{ patternA: "src/**", patternB: "src/**" }] },
        { kind: "resource", taskIdA: "T1", taskIdB: "T2", resources: ["database"] },
      ],
    }),
    async close() {},
    ...overrides,
  } as unknown as RunnerAppService;
}

describe("planning CLI commands", () => {
  it("renders bounded analysis findings", async () => {
    const { io, lines } = captureIo();
    expect(await executeAnalyzeCommand(service(), io)).toBe(0);
    expect(lines.join("\n")).toContain("base revision: abc123");
    expect(lines.join("\n")).toContain("absent: docs/ROADMAP.md");
  });

  it("renders discovery questions and a draft summary", async () => {
    const { io, lines } = captureIo();
    expect(await executePlanCommand("Build a TODO app", service(), io)).toBe(0);
    expect(lines.join("\n")).toContain("NEEDS_DISCOVERY");
    expect(lines.join("\n")).toContain("Where should tasks persist?");

    lines.length = 0;
    expect(await executePlanShowCommand(undefined, service(), io)).toBe(0);
    expect(lines.join("\n")).toContain("plan-0123456789abcdef");
    expect(lines.join("\n")).toContain("parallelizable: 1");
    expect(lines.join("\n")).toContain("objective: Create an item");
    expect(lines.join("\n")).toContain("scheduling conflict: T1 / T2");
    expect(lines.join("\n")).toContain("src/** overlaps src/**");
    expect(lines.join("\n")).toContain("shared resources: database");
    expect(lines.join("\n")).toContain("draft is not executable");

    lines.length = 0;
    const draftPreview = await service().showPlan!();
    expect(await executePlanShowCommand("plan-0123456789abcdef", service({
      showPlan: async () => ({ ...draftPreview!, approvalStatus: "approved" }),
    }), io)).toBe(0);
    expect(lines.join("\n")).toContain("This plan is approved; its tasks are in runner state.");
    expect(lines.join("\n")).not.toContain("draft is not executable");

    lines.length = 0;
    expect(await executePlanShowCommand("plan-0123456789abcdef", service({
      showPlan: async () => ({ ...draftPreview!, approvalStatus: "changed" }),
    }), io)).toBe(0);
    expect(lines.join("\n")).toContain("This plan was approved earlier, but the draft changed; this preview isn't the imported task set.");
    expect(lines.join("\n")).toContain("Inspect the imported tasks with agentic tasks");
  });

  it("dispatches plan generation through the application service without starting tasks", async () => {
    let goal = "";
    const planned = service({ plan: async (requestedGoal: string) => {
      goal = requestedGoal;
      return { kind: "NEEDS_DISCOVERY", questions: [{ id: "storage", prompt: "Where should tasks persist?", reason: "Persistence is important.", importance: "important", choices: ["Browser", "SQLite"] }] };
    } });
    const { io, lines } = captureIo();
    expect(await runCli(["plan", "--goal", "Build a TODO app"], { io, servicesFactory: async () => planned })).toBe(0);
    expect(goal).toBe("Build a TODO app");
    expect(lines.join("\n")).toContain("NEEDS_DISCOVERY");
  });

  it("returns nonzero and reports planning service failures", async () => {
    const { io, errors } = captureIo();
    const failing = service({ analyze: async () => { throw new Error("not a Git repository"); } });
    const exitCode = await runCli(["analyze"], { io, servicesFactory: async () => failing });
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("not a Git repository");
  });
});

describe("store-backed planning service", () => {
  it("analyzes the repository and sends the goal to the configured planner", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createSqliteRunnerStore } = await import("@agentic-dev-runner/persistence");
    const { createStoreBackedAppService } = await import("../src/application/store-backed-app-service.js");
    const root = await mkdtemp(join(tmpdir(), "agentic-planning-service-"));
    const store = createSqliteRunnerStore({ path: ":memory:" });
    const questions = [{ id: "storage", prompt: "Where?", reason: "Important", importance: "important" as const, choices: ["Local"] }];
    const calls: { root: string; goal: string; taskIds: readonly string[] }[] = [];
    const service = createStoreBackedAppService({
      storePath: ":memory:", projectRoot: root, store,
      orchestrator: {} as never, recovery: { reconcileUnfinished: async () => [] } as never, agents: {} as never,
      analyzeRepository: async (projectRoot, goal = "", taskIds = []) => {
        calls.push({ root: projectRoot, goal, taskIds });
        return { ...input, repositoryRoot: projectRoot, goal, existingTaskIds: taskIds };
      },
      planRepository: async () => ({ kind: "NEEDS_DISCOVERY", questions }),
    });
    try {
      await store.initialize();
      expect((await service.analyze!()).repositoryRoot).toBe(root);
      expect((await service.plan!("Build a TODO app")).kind).toBe("NEEDS_DISCOVERY");
      expect(calls[0]).toEqual({ root, goal: "", taskIds: [] });
      expect(calls[1]).toEqual({ root, goal: "Build a TODO app", taskIds: [] });
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("store-backed plan preview", () => {
  it("counts only dependency-ready tasks without path or resource conflicts", async () => {
    const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createSqliteRunnerStore } = await import("@agentic-dev-runner/persistence");
    const { createStoreBackedAppService } = await import("../src/application/store-backed-app-service.js");
    const { writePlanDraft } = await import("../src/application/planning/plan-files.js");
    const root = await mkdtemp(join(tmpdir(), "agentic-plan-preview-"));
    const store = createSqliteRunnerStore({ path: ":memory:" });
    try {
      const task = (id: string, allowedPaths = ["src/**"], approvalRequired = false, risk: "low" | "high" = "low", checks: string[] = [], resources: string[] = []) => ({
        id, title: `Task ${id}`, milestone: "M1", status: "READY" as const, priority: "P0" as const,
        risk, type: "implementation" as const, objective: "Do work", acceptanceCriteria: ["Done"],
        dependsOn: [], provenance: { kind: "roadmap_criterion" as const, source: "plan" },
        scope: { allowedPaths, forbiddenPaths: [] }, resources, workflow: "simple",
        routing: { complexity: "small" as const, capabilities: [] }, verification: { required: checks },
        limits: { maxAttempts: 3, maxReviewCycles: 2 }, approval: { required: approvalRequired },
      });
      const result = {
        version: 1 as const, kind: "READY_FOR_PLANNING" as const,
        milestones: [{ id: "M1", title: "Core", completionCriteria: ["Done"] }],
        tasks: [{ id: "T1" }, { id: "T2" }],
      };
      const draft = await writePlanDraft(root, input, result, [task("T1"), task("T2")]);
      const service = createStoreBackedAppService({
        storePath: ":memory:", projectRoot: root, store,
        orchestrator: {} as never, recovery: { reconcileUnfinished: async () => [] } as never, agents: {} as never,
        configuration: { verificationChecks: [{ name: "unit", command: "pnpm", args: ["test"] }], agentProfiles: [] },
      });
      const preview = await service.showPlan!(draft.planId);
      expect(preview?.parallelizableTaskCount).toBe(1);
      expect(preview?.tasks).toHaveLength(2);
      expect(preview?.conflicts).toEqual([{
        kind: "path", taskIdA: "T1", taskIdB: "T2", patterns: [{ patternA: "src/**", patternB: "src/**" }],
      }]);

      const planPath = join(root, ".agentic", "plans", draft.planId, "plan.json");
      const edited = JSON.parse(await readFile(planPath, "utf8")) as Record<string, unknown>;
      const editedResult = edited["result"] as Record<string, unknown>;
      editedResult["milestones"] = [null];
      await writeFile(planPath, JSON.stringify(edited));
      await expect(service.showPlan!(draft.planId)).rejects.toThrow(/milestone/);

      editedResult["milestones"] = result.milestones;
      edited["tasks"] = [task("T1"), task("T1")];
      await writeFile(planPath, JSON.stringify(edited));
      await expect(service.showPlan!(draft.planId)).rejects.toThrow(/duplicate task id/);

      edited["tasks"] = [{ ...task("T1"), milestone: "unknown" }];
      await writeFile(planPath, JSON.stringify(edited));
      await expect(service.showPlan!(draft.planId)).rejects.toThrow(/unknown milestone/);

      edited["tasks"] = [{ ...task("T1"), dependsOn: ["missing"] }];
      await writeFile(planPath, JSON.stringify(edited));
      await expect(service.showPlan!(draft.planId)).rejects.toThrow(/does not exist/);

      edited["tasks"] = [{ ...task("T1"), dependsOn: ["T2"] }, { ...task("T2"), dependsOn: ["T1"] }];
      await writeFile(planPath, JSON.stringify(edited));
      await expect(service.showPlan!(draft.planId)).rejects.toThrow(/cycle/);

      const approvalDraft = await writePlanDraft(root, input, {
        ...result, tasks: [{ id: "T3" }, { id: "T4" }],
      }, [task("T3", ["src/a/**"]), task("T4", ["src/b/**"], true, "high")]);
      const approvalPreview = await service.showPlan!(approvalDraft.planId);
      expect(approvalPreview?.parallelizableTaskCount).toBe(1);
      expect(approvalPreview?.tasks.filter((item) => item.approvalRequired)).toHaveLength(1);

      const verificationDraft = await writePlanDraft(root, input, {
        ...result, tasks: [{ id: "T5" }],
      }, [task("T5", ["src/check/**"], false, "low", ["unit"])]);
      const verificationPath = join(root, ".agentic", "plans", verificationDraft.planId, "plan.json");
      const verificationEdited = JSON.parse(await readFile(verificationPath, "utf8")) as Record<string, unknown>;
      const editedTasks = verificationEdited["tasks"] as Record<string, unknown>[];
      editedTasks[0] = { ...editedTasks[0], verification: { required: ["unknown"] } };
      await writeFile(verificationPath, JSON.stringify(verificationEdited));
      await expect(service.showPlan!(verificationDraft.planId)).rejects.toThrow(/not configured/);

      const highRiskDraft = await writePlanDraft(root, input, {
        ...result, tasks: [{ id: "T6" }],
      }, [task("T6", ["src/high/**"], false, "high")]);
      const highRiskPath = join(root, ".agentic", "plans", highRiskDraft.planId, "plan.json");
      const highRiskEdited = JSON.parse(await readFile(highRiskPath, "utf8")) as Record<string, unknown>;
      const highRiskTasks = highRiskEdited["tasks"] as Record<string, unknown>[];
      highRiskTasks[0] = { ...highRiskTasks[0], approval: { required: false } };
      await writeFile(highRiskPath, JSON.stringify(highRiskEdited));
      const highRiskPreview = await service.showPlan!(highRiskDraft.planId);
      expect(highRiskPreview?.tasks[0]?.approvalRequired).toBe(true);
      expect(highRiskPreview?.parallelizableTaskCount).toBe(0);

      const resourceDraft = await writePlanDraft(root, input, {
        ...result, tasks: [{ id: "T7" }, { id: "T8" }],
      }, [task("T7", ["src/a/**"], false, "low", [], ["database"]), task("T8", ["src/b/**"], false, "low", [], ["database"])]);
      const resourcePreview = await service.showPlan!(resourceDraft.planId);
      expect(resourcePreview?.conflicts).toEqual([{
        kind: "resource", taskIdA: "T7", taskIdB: "T8", resources: ["database"],
      }]);
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
