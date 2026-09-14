import { describe, expect, it } from "vitest";
import { buildContextPack, type Task } from "@agentic-dev-runner/context";
import type {
  AgentDescriptor,
  AgentExecutionResult,
  AgentInvocation,
  AgentRuntime,
} from "@agentic-dev-runner/agents";

function makeTask(): Task {
  return {
    id: "VS008",
    projectId: "proj-1",
    title: "Invoke an agent",
    milestone: "vertical-slice",
    status: "READY",
    type: "implementation",
    priority: "P0",
    risk: "low",
    definition: {
      objective: "Invoke one agent with a context pack.",
      acceptanceCriteria: ["Normalized result is returned."],
      scope: {
        allowedPaths: ["src/**"],
        forbiddenPaths: ["docs/**"],
      },
      resources: [],
      verification: { required: ["typecheck", "unit"] },
      limits: { maxAttempts: 3, maxReviewCycles: 2 },
      approval: { required: false },
    },
    routing: { complexity: "small", capabilities: ["typescript"] },
    provenance: { kind: "user_request", source: "manual" },
    dependsOn: [],
    workflow: "default",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeContextPack() {
  return buildContextPack({
    task: makeTask(),
    agentsMarkdown: "# Rules",
    documents: [{ path: "docs/ARCHITECTURE.md", content: "# Architecture" }],
    baseRevision: "abc1234",
    createdAt: "2026-01-01T00:00:05.000Z",
  });
}

function makeInvocation(
  overrides?: Partial<AgentInvocation>,
): AgentInvocation {
  return {
    agent: { id: "opencode", model: "test-model" },
    contextPack: makeContextPack(),
    worktreePath: "C:/worktrees/task-vs008 dir",
    timeoutMs: 60_000,
    ...overrides,
  };
}

function createFakeAgentRuntime(
  behavior: (
    invocation: AgentInvocation,
  ) => AgentExecutionResult | Promise<AgentExecutionResult>,
): AgentRuntime {
  const descriptor: AgentDescriptor = { id: "fake", capabilities: [] };
  return {
    descriptor,
    invoke: (invocation) => Promise.resolve(behavior(invocation)),
  };
}

const RESULT_BEHAVIORS = [
  (): AgentExecutionResult => ({
    kind: "success",
    output: { stdout: "implementation complete", stderr: "" },
    exitCode: 0,
    durationMs: 1_500,
  }),
  (): AgentExecutionResult => ({
    kind: "failure",
    failure: { kind: "process", message: "agent exited with code 1" },
    output: { stdout: "", stderr: "boom" },
    durationMs: 300,
  }),
  (): AgentExecutionResult => ({
    kind: "timeout",
    output: { stdout: "partial work", stderr: "" },
    durationMs: 60_000,
  }),
  (): AgentExecutionResult => ({
    kind: "cancelled",
    output: { stdout: "", stderr: "" },
    durationMs: 10,
  }),
] as const;

describe("AgentRuntime contract", () => {
  it("normalizes a successful result", async () => {
    const runtime = createFakeAgentRuntime(RESULT_BEHAVIORS[0]);
    const result = await runtime.invoke(makeInvocation());

    expect(result.kind).toBe("success");
    expect(result).toEqual({
      kind: "success",
      output: { stdout: "implementation complete", stderr: "" },
      exitCode: 0,
      durationMs: 1_500,
    } satisfies AgentExecutionResult);
  });

  it("normalizes an agent/process failure result", async () => {
    const runtime = createFakeAgentRuntime(RESULT_BEHAVIORS[1]);
    const result = await runtime.invoke(makeInvocation());

    expect(result.kind).toBe("failure");
    if (result.kind === "failure") {
      expect(result.failure.kind).toBe("process");
      expect(result.failure.message).toContain("code 1");
      expect(result.output.stderr).toBe("boom");
    }
  });

  it("normalizes a timeout result", async () => {
    const runtime = createFakeAgentRuntime(RESULT_BEHAVIORS[2]);
    const result = await runtime.invoke(makeInvocation({ timeoutMs: 60_000 }));

    expect(result.kind).toBe("timeout");
    if (result.kind === "timeout") {
      expect(result.durationMs).toBe(60_000);
      expect(result.output.stdout).toBe("partial work");
    }
  });

  it("normalizes a cancellation result", async () => {
    const controller = new AbortController();
    const runtime = createFakeAgentRuntime(RESULT_BEHAVIORS[3]);
    const result = await runtime.invoke(
      makeInvocation({ signal: controller.signal }),
    );

    expect(result.kind).toBe("cancelled");
    if (result.kind === "cancelled") {
      expect(result.durationMs).toBe(10);
    }
  });

  it("passes the ContextPack to the adapter unchanged", async () => {
    const invocation = makeInvocation();
    let received: AgentInvocation["contextPack"] | undefined;
    const runtime = createFakeAgentRuntime((receivedInvocation) => {
      received = receivedInvocation.contextPack;
      return {
        kind: "success",
        output: { stdout: "" },
        durationMs: 1,
      };
    });

    await runtime.invoke(invocation);

    expect(received).toEqual(invocation.contextPack);
    expect(received).toBe(invocation.contextPack);
  });

  it("passes the working directory unchanged", async () => {
    const invocation = makeInvocation();
    let receivedPath: string | undefined;
    const runtime = createFakeAgentRuntime((receivedInvocation) => {
      receivedPath = receivedInvocation.worktreePath;
      return { kind: "success", output: {}, durationMs: 1 };
    });

    await runtime.invoke(invocation);

    expect(receivedPath).toBe("C:/worktrees/task-vs008 dir");
  });

  it("requires no provider-specific fields in the shared contract", async () => {
    let invocationKeys: string[] = [];
    let resultKeys: string[] = [];
    const runtime = createFakeAgentRuntime((receivedInvocation) => {
      invocationKeys = Object.keys(receivedInvocation);
      const result: AgentExecutionResult = {
        kind: "success",
        output: { stdout: "done" },
        durationMs: 5,
      };
      resultKeys = Object.keys(result);
      return result;
    });

    const invocation = makeInvocation({
      agent: { id: "any-provider" },
      signal: new AbortController().signal,
    });
    const result = await runtime.invoke(invocation);

    expect([...invocationKeys].sort()).toEqual([
      "agent",
      "contextPack",
      "signal",
      "timeoutMs",
      "worktreePath",
    ]);
    expect([...resultKeys].sort()).toEqual(["durationMs", "kind", "output"]);
    expect(result.kind).toBe("success");
  });
});
