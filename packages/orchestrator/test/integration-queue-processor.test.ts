import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  Attempt,
  IntegrationDriftEvaluation,
  Task,
} from "@agentic-dev-runner/core";
import type { GitManager } from "@agentic-dev-runner/git";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import { createSqliteRunnerStore } from "@agentic-dev-runner/persistence";
import type {
  VerificationEngine,
  VerificationRunInput,
} from "@agentic-dev-runner/verification";
import {
  createIntegrationQueueProcessor,
  type IntegrationDriftService,
  type IntegrationReconciliationOutcome,
} from "../src/index.js";
import {
  createProject,
  createTask,
  cancelledVerificationRun,
  passedVerificationRun,
} from "./fixtures.js";

describe("integration queue processor (M047b)", () => {
  let directory: string;
  let store: RunnerStore;
  let task: Task;
  let attempt: Attempt;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "agentic-runner-m047b-"));
    testDirectory = directory;
    store = createSqliteRunnerStore({ path: join(directory, "state.db") });
    await store.initialize();
    await store.putProject(createProject());
    task = processingTask();
    attempt = {
      id: "att_M001_1",
      taskId: task.id,
      number: 1,
      status: "RUNNING",
      agent: "fake-agent",
      baseRevision: "base-revision",
      startedAt: clock(),
    };
    await store.putTask(task);
    await store.putAttempt(attempt);
  });

  afterEach(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("distinguishes an empty queue from a blocked queue", async () => {
    const processor = createProcessor(store, currentDrift());
    expect(await processor.processNext()).toEqual({ kind: "empty" });

    await store.putTask({ ...task, status: "INTEGRATING" });
    await store.enqueueIntegrationQueueEntry(queueRequest());
    const claimed = await store.claimNextIntegrationQueueEntry(clock());
    expect(claimed?.status).toBe("INTEGRATING");

    const blocked = await processor.processNext();
    expect(blocked.kind).toBe("blocked");
    if (blocked.kind === "blocked") {
      expect(blocked.activeEntry.id).toBe(claimed?.id);
    }
  });

  it("claims and processes one no-drift item with integration verification", async () => {
    await enqueue();
    const integrationCalls: string[] = [];
    const processor = createProcessor(store, currentDrift(), {
      integrateBranch: async (_cwd, branch) => {
        integrationCalls.push(branch);
        return { kind: "fast-forward", revision: "task-revision" };
      },
    });

    const result = await processor.processNext();

    expect(result.kind).toBe("processed");
    expect(integrationCalls).toEqual(["task/M001/attempt-1"]);
    expect((await store.getTask(task.id))?.status).toBe("DONE");
    expect((await store.getAttempt(attempt.id))?.status).toBe("SUCCEEDED");
    expect((await store.listIntegrationQueueEntries())[0]?.status).toBe("COMPLETED");
    const events = await store.listEvents({ taskId: task.id });
    expect(events.find((event) => event.type === "integration.verification.completed")?.payload).toMatchObject({
      revision: "task-revision",
    });
  });

  it("threads a reconciled revision through re-verification and evidence", async () => {
    await enqueue();
    const evaluateRevisions: string[] = [];
    const drift: IntegrationDriftService = {
      async reconcile(): Promise<IntegrationReconciliationOutcome> {
        return {
          kind: "reconciled",
          baseRevision: "base-revision",
          previousTaskRevision: "task-revision",
          taskRevision: "reconciled-revision",
          integrationHead: "integration-head",
          detail: "rebased",
          verificationRequired: true,
        };
      },
      async evaluate(input): Promise<IntegrationDriftEvaluation> {
        evaluateRevisions.push(input.taskRevision);
        return {
          status: "CURRENT",
          baseRevision: input.baseRevision,
          taskRevision: input.taskRevision,
          integrationHead: input.baseRevision,
          detail: "current",
        };
      },
    };
    const verificationInputs: VerificationRunInput[] = [];
    const processor = createProcessor(store, drift, {
      verification: {
        async run(input) {
          verificationInputs.push(input);
          return passedVerificationRun(input);
        },
      },
      integrateBranch: async () => ({
        kind: "fast-forward",
        revision: "reconciled-revision",
      }),
    });

    const result = await processor.processNext();

    expect(result).toMatchObject({ kind: "processed", taskRevision: "reconciled-revision" });
    expect(evaluateRevisions).toEqual(["reconciled-revision"]);
    expect(verificationInputs.map((input) => input.cwd)).toEqual([
      join(directory, "worktrees", "M001", "attempt-1"),
      "project-root",
    ]);
    const events = await store.listEvents({ taskId: task.id });
    expect(events.filter((event) => event.type === "verification.completed")[0]?.payload).toMatchObject({
      revision: "reconciled-revision",
    });
    expect(events.find((event) => event.type === "integration.verification.completed")?.payload).toMatchObject({
      revision: "reconciled-revision",
    });
    expect((await store.listIntegrationQueueEntries())[0]?.taskRevision).toBe(
      "task-revision",
    );
  });

  it("settles a verification failure as a failed queue item and task", async () => {
    await enqueue();
    const processor = createProcessor(store, currentDrift(), {
      verification: {
        async run(input) {
          return {
            ...passedVerificationRun(input),
            status: "FAILED",
            passed: false,
            checks: [],
          };
        },
      },
    });

    const result = await processor.processNext();

    expect(result.kind).toBe("failed");
    expect((await store.getTask(task.id))?.status).toBe("FAILED");
    expect((await store.getAttempt(attempt.id))?.status).toBe("FAILED");
    expect((await store.listIntegrationQueueEntries())[0]?.status).toBe("FAILED");
  });

  it("retains execution locks when durable queue settlement fails", async () => {
    await store.putTask({ ...task, status: "READY" });
    const claim = await store.claimTaskExecution({
      taskId: task.id,
      executionId: "exec-settlement-failure",
      maxParallelism: 1,
      resources: task.definition.resources,
      claimedAt: clock(),
      leaseExpiresAt: "2026-01-01T00:00:30.000Z",
    });
    expect(claim.kind).toBe("claimed");
    await store.putTask({ ...task, status: "INTEGRATING" });
    await store.enqueueIntegrationQueueEntry(
      queueRequest("exec-settlement-failure"),
    );
    const failingStore = new Proxy(store, {
      get(target, property) {
        if (property === "transaction") {
          return async () => {
            throw new Error("simulated settlement persistence failure");
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const result = await createProcessor(failingStore, currentDrift()).processNext();

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.recoveryRequired).toBe(true);
    }
    expect(await store.listExecutionClaims({ status: "ACTIVE" })).toHaveLength(1);
    expect(await store.listResourceLocks()).toHaveLength(1);
    expect((await store.listIntegrationQueueEntries())[0]?.status).toBe(
      "INTEGRATING",
    );
  });

  it("maps queue cancellation to CANCELLED task and attempt states", async () => {
    await enqueue();
    const processor = createProcessor(store, currentDrift(), {
      verification: {
        async run(input) {
          return cancelledVerificationRun(input);
        },
      },
    });

    const result = await processor.processNext();

    expect(result.kind).toBe("failed");
    expect((await store.getTask(task.id))?.status).toBe("CANCELLED");
    expect((await store.getAttempt(attempt.id))?.status).toBe("CANCELLED");
    expect((await store.listIntegrationQueueEntries())[0]?.status).toBe("FAILED");
  });

  it("recovers an already integrated entry without replaying Git integration", async () => {
    await enqueue();
    const claimed = await store.claimNextIntegrationQueueEntry(clock());
    expect(claimed?.status).toBe("INTEGRATING");
    let integrations = 0;
    const drift: IntegrationDriftService = {
      async reconcile(): Promise<IntegrationReconciliationOutcome> {
        return { kind: "already-integrated", baseRevision: "base-revision", taskRevision: "task-revision", integrationHead: "integrated-head", detail: "already integrated" };
      },
      async evaluate(input): Promise<IntegrationDriftEvaluation> {
        return { status: "CURRENT", baseRevision: input.baseRevision, taskRevision: input.taskRevision, integrationHead: input.baseRevision, detail: "current" };
      },
    };
    const git = {
      resolveHeadRevision: async () => "integrated-head",
      isAncestor: async () => true,
      integrateBranch: async () => { integrations += 1; throw new Error("must not integrate twice"); },
      worktreeExists: async () => false,
    } as unknown as GitManager;
    const processor = createIntegrationQueueProcessor({ store, git, drift, verification: verificationEngine, verificationChecks: [{ name: "unit", executable: "node" }], projectRoot: "project-root", worktreesDir: join(directory, "worktrees"), now: clock });
    expect((await processor.recoverAbandoned())[0]?.kind).toBe("processed");
    expect(integrations).toBe(0);
    expect((await store.getTask(task.id))?.status).toBe("DONE");
  });

  async function enqueue(): Promise<void> {
    await store.putTask({ ...task, status: "INTEGRATING" });
      await store.enqueueIntegrationQueueEntry(queueRequest());
  }

  function queueRequest(executionId?: string) {
    return {
      taskId: task.id,
      attemptId: attempt.id,
      taskRevision: "task-revision",
      branch: "task/M001/attempt-1",
      baseRevision: "base-revision",
      enqueuedAt: clock(),
      ...(executionId === undefined ? {} : { executionId }),
    };
  }
});

function createProcessor(
  store: RunnerStore,
  drift: IntegrationDriftService,
  overrides: {
    verification?: VerificationEngine;
    integrateBranch?: GitManager["integrateBranch"];
  } = {},
) {
  const git = {
    integrateBranch:
      overrides.integrateBranch ??
      (async () => ({ kind: "fast-forward" as const, revision: "task-revision" })),
    worktreeExists: async () => false,
  } as unknown as GitManager;
  return createIntegrationQueueProcessor({
    store,
    git,
    drift,
    verification: overrides.verification ?? verificationEngine,
    verificationChecks: [{ name: "unit", executable: "node" }],
    projectRoot: "project-root",
    worktreesDir: join(testDirectory, "worktrees"),
    now: clock,
  });
}

const verificationEngine: VerificationEngine = {
  async run(input) {
    return passedVerificationRun(input);
  },
};

let testDirectory = "";

function currentDrift(): IntegrationDriftService {
  return {
    async reconcile(): Promise<IntegrationReconciliationOutcome> {
      return {
        kind: "current",
        baseRevision: "base-revision",
        taskRevision: "task-revision",
        integrationHead: "base-revision",
        detail: "current",
      };
    },
    async evaluate(input): Promise<IntegrationDriftEvaluation> {
      return {
        status: "CURRENT",
        baseRevision: input.baseRevision,
        taskRevision: input.taskRevision,
        integrationHead: input.baseRevision,
        detail: "current",
      };
    },
  };
}

function processingTask(): Task {
  const value = createTask({ id: "M001", status: "INTEGRATING" });
  return {
    ...value,
    definition: {
      ...value.definition,
      verification: { required: ["unit"] },
    },
  };
}

function clock(): string {
  return "2026-01-01T00:00:00.000Z";
}
