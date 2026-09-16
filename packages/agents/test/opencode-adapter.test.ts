import { copyFileSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildContextPack, stableStringify, type Task } from "@agentic-dev-runner/context";
import {
  createNodeProcessRunner,
  type ProcessRunner,
} from "@agentic-dev-runner/platform";
import {
  OpenCodeAdapter,
  OpenCodeAdapterError,
  type AgentExecutionResult,
  type AgentInvocation,
} from "../src/index.js";
import type { ContextPack } from "@agentic-dev-runner/core";

const SPACED_DIR_PREFIX = "agentic worktree vs009 spaced dir ";
const CONTEXT_DIR_PREFIX = "agentic-opencode-context-";

function countContextDirs(): number {
  return readdirSync(tmpdir()).filter((entry) =>
    entry.startsWith(CONTEXT_DIR_PREFIX),
  ).length;
}

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function placeExecutableCopy(target: string): void {
  try {
    linkSync(process.execPath, target);
  } catch {
    copyFileSync(process.execPath, target);
  }
}

function makeTask(): Task {
  return {
    id: "VS009",
    projectId: "proj-1",
    title: "Run one agent in a worktree",
    milestone: "vertical-slice",
    status: "READY",
    type: "implementation",
    priority: "P0",
    risk: "low",
    definition: {
      objective: "Execute one bounded implementation task.",
      acceptanceCriteria: ["Normalized result is produced."],
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

type FakeAgentReport = {
  argv: string[];
  cwd: string;
  contextContent: string | null;
};

describe("OpenCodeAdapter", () => {
  let runner: ProcessRunner;
  let spacedDir: string;
  let worktreePath: string;
  let executable: string;
  let contextPack: ContextPack;

  beforeEach(() => {
    runner = createNodeProcessRunner();
    spacedDir = mkdtempSync(join(tmpdir(), SPACED_DIR_PREFIX));
    worktreePath = join(spacedDir, "task worktree dir");
    mkdirSync(worktreePath, { recursive: true });
    executable = join(spacedDir, "fake agent node copy.exe");
    placeExecutableCopy(executable);
    contextPack = buildContextPack({
      task: makeTask(),
      agentsMarkdown: "# Rules",
      documents: [{ path: "docs/ARCHITECTURE.md", content: "# Architecture" }],
      baseRevision: "abc1234",
      createdAt: "2026-01-01T00:00:05.000Z",
    });
  });

  afterEach(() => {
    rmSync(spacedDir, { recursive: true, force: true });
    delete process.env.FAKE_AGENT_EXIT_CODE;
    delete process.env.FAKE_AGENT_DELAY_MS;
  });

  function makeInvocation(
    overrides?: Partial<AgentInvocation>,
  ): AgentInvocation {
    return {
      agent: { id: "opencode", model: "provider/test-model" },
      contextPack,
      worktreePath,
      timeoutMs: 15_000,
      ...overrides,
    };
  }

  function makeAdapter(): OpenCodeAdapter {
    return new OpenCodeAdapter(runner, {
      executable,
      launcherArgs: [fixturePath("fake-opencode.mjs")],
    });
  }

  it("invokes the fake CLI with deterministic arguments in the supplied worktree and delivers the ContextPack", async () => {
    const adapter = makeAdapter();
    const result = await adapter.invoke(makeInvocation());

    expect(result.kind).toBe("success");
    const report = JSON.parse(
      result.kind === "success" ? (result.output.stdout ?? "") : "",
    ) as FakeAgentReport;
    expect(report.argv.slice(0, 4)).toEqual([
      "run",
      "--model",
      "provider/test-model",
      expect.any(String),
    ]);
    expect(report.cwd).toBe(worktreePath);
    expect(report.contextContent).toBe(stableStringify(contextPack));
  });

  it("captures stdout and stderr and normalizes success", async () => {
    const adapter = makeAdapter();
    const result = await adapter.invoke(makeInvocation());

    expect(result).toEqual({
      kind: "success",
      output: { stdout: expect.any(String), stderr: "" },
      exitCode: 0,
      durationMs: expect.any(Number),
    } satisfies AgentExecutionResult);
  });

  it("normalizes a non-zero exit as a process failure", async () => {
    process.env.FAKE_AGENT_EXIT_CODE = "3";
    const adapter = makeAdapter();
    const result = await adapter.invoke(makeInvocation());

    expect(result.kind).toBe("failure");
    if (result.kind === "failure") {
      expect(result.failure.kind).toBe("process");
      expect(result.failure.message).toContain("exited with code 3");
      expect(result.output.stderr).toBe("");
    }
  });

  it("normalizes timeout through the ProcessRunner", async () => {
    process.env.FAKE_AGENT_DELAY_MS = "2000";
    const adapter = makeAdapter();
    const result = await adapter.invoke(makeInvocation({ timeoutMs: 200 }));

    expect(result.kind).toBe("timeout");
    if (result.kind === "timeout") {
      expect(result.durationMs).toBeLessThan(2000);
      expect(result.output.stdout).toBe("");
    }
  });

  it("normalizes cancellation through the ProcessRunner", async () => {
    process.env.FAKE_AGENT_DELAY_MS = "2000";
    const controller = new AbortController();
    const adapter = makeAdapter();
    const pending = adapter.invoke(
      makeInvocation({ timeoutMs: 15_000, signal: controller.signal }),
    );
    await delay(150);
    controller.abort();
    const result = await pending;

    expect(result.kind).toBe("cancelled");
    if (result.kind === "cancelled") {
      expect(result.durationMs).toBeGreaterThan(0);
    }
  });

  it("rejects an invalid invocation before spawning", async () => {
    const adapter = makeAdapter();

    await expect(
      adapter.invoke(makeInvocation({ timeoutMs: 0 })),
    ).rejects.toThrow(OpenCodeAdapterError);
    await expect(
      adapter.invoke(makeInvocation({ worktreePath: "" })),
    ).rejects.toThrow(OpenCodeAdapterError);
  });

  it("fails with an adapter failure when the executable cannot start", async () => {
    const missing = join(spacedDir, "missing opencode.exe");
    const adapter = new OpenCodeAdapter(runner, { executable: missing });
    const result = await adapter.invoke(makeInvocation());

    expect(result.kind).toBe("failure");
    if (result.kind === "failure") {
      expect(result.failure.kind).toBe("adapter");
      expect(result.failure.message).toContain("failed to start opencode");
    }
  });

  it("falls back to adapter configuration when the invocation has no model", async () => {
    const adapter = new OpenCodeAdapter(runner, {
      executable,
      launcherArgs: [fixturePath("fake-opencode.mjs")],
      model: "provider/fallback-model",
    });
    const result = await adapter.invoke(
      makeInvocation({ agent: { id: "opencode" } }),
    );

    expect(result.kind).toBe("success");
    const report = JSON.parse(
      result.kind === "success" ? (result.output.stdout ?? "") : "",
    ) as FakeAgentReport;
    expect(report.argv.slice(0, 3)).toEqual([
      "run",
      "--model",
      "provider/fallback-model",
    ]);
  });

  it("omits the model flag when no model is configured anywhere", async () => {
    const adapter = new OpenCodeAdapter(runner, {
      executable,
      launcherArgs: [fixturePath("fake-opencode.mjs")],
    });
    const result = await adapter.invoke(
      makeInvocation({ agent: { id: "opencode" } }),
    );

    expect(result.kind).toBe("success");
    const report = JSON.parse(
      result.kind === "success" ? (result.output.stdout ?? "") : "",
    ) as FakeAgentReport;
    expect(report.argv).toEqual(["run", expect.any(String)]);
    expect(report.argv).not.toContain("--model");
  });

  it("renders the stage instruction into the provider prompt", async () => {
    const adapter = makeAdapter();
    const instruction = "STAGE PLAN — planning only. Produce a plan, not code.";
    const result = await adapter.invoke(makeInvocation({ instruction }));

    expect(result.kind).toBe("success");
    const report = JSON.parse(
      result.kind === "success" ? (result.output.stdout ?? "") : "",
    ) as FakeAgentReport;
    expect(report.argv.at(-1)).toContain(instruction);
    expect(report.argv.at(-1)).toContain('Read the task context pack at "');
    expect(report.contextContent).toBe(stableStringify(contextPack));
  });

  it("removes temp context artifacts after a successful invocation", async () => {
    const before = countContextDirs();
    const adapter = makeAdapter();
    const result = await adapter.invoke(makeInvocation());

    expect(result.kind).toBe("success");
    expect(countContextDirs()).toBe(before);
  });

  it("removes temp context artifacts after a spawn-error invocation", async () => {
    const before = countContextDirs();
    const missing = join(spacedDir, "missing opencode.exe");
    const adapter = new OpenCodeAdapter(runner, { executable: missing });
    const result = await adapter.invoke(makeInvocation());

    expect(result.kind).toBe("failure");
    expect(countContextDirs()).toBe(before);
  });

  it("does not write the context pack into the supplied task worktree", async () => {
    const adapter = makeAdapter();
    const result = await adapter.invoke(makeInvocation());

    expect(result.kind).toBe("success");
    expect(readdirSync(worktreePath)).toEqual([]);
  });

  it("resolves with the primary result even when temp cleanup fails", async () => {
    const adapter = new OpenCodeAdapter(runner, {
      executable,
      launcherArgs: [fixturePath("fake-opencode.mjs")],
      removeDirectory: async () => {
        throw new Error("simulated cleanup failure");
      },
    });
    const result = await adapter.invoke(makeInvocation());

    expect(result.kind).toBe("success");
    expect(countContextDirs()).toBeGreaterThan(0);
    const report = JSON.parse(
      result.kind === "success" ? (result.output.stdout ?? "") : "",
    ) as FakeAgentReport;
    expect(report.contextContent).toBe(stableStringify(contextPack));
  });

  it("resolves with a normalized failure even when temp cleanup fails", async () => {
    const missing = join(spacedDir, "missing opencode.exe");
    const adapter = new OpenCodeAdapter(runner, {
      executable: missing,
      removeDirectory: async () => {
        throw new Error("simulated cleanup failure");
      },
    });
    const result = await adapter.invoke(makeInvocation());

    expect(result.kind).toBe("failure");
    if (result.kind === "failure") {
      expect(result.failure.kind).toBe("adapter");
    }
  });
});

const SMOKE_ENABLED = process.env.AGENTIC_OPENCODE_SMOKE === "1";

describe.skipIf(!SMOKE_ENABLED)("OpenCode real CLI smoke test", () => {
  it("detects the installed opencode CLI", async () => {
    const runner = createNodeProcessRunner();
    const version = await runner.run({
      executable: "opencode",
      args: ["--version"],
    });
    if (
      version.outcome.kind === "spawn-error" &&
      version.outcome.code === "ENOENT"
    ) {
      throw new Error(
        "AGENTIC_OPENCODE_SMOKE is enabled but opencode was not found on PATH",
      );
    }
    expect(version.outcome).toEqual({ kind: "completed", code: 0 });
    expect(version.stdout.trim().length).toBeGreaterThan(0);
  });
});
