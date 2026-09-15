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
  CodexAdapter,
  CodexAdapterError,
  type AgentExecutionResult,
  type AgentInvocation,
} from "../src/index.js";
import type { ContextPack } from "@agentic-dev-runner/core";

const SPACED_DIR_PREFIX = "agentic worktree m033a spaced dir ";
const CONTEXT_DIR_PREFIX = "agentic-codex-context-";

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
    id: "M033A",
    projectId: "proj-1",
    title: "Run Codex adapter in a worktree",
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

describe("CodexAdapter", () => {
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
    executable = join(spacedDir, "fake codex node copy.exe");
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
      agent: { id: "codex", model: "provider/test-model" },
      contextPack,
      worktreePath,
      timeoutMs: 15_000,
      ...overrides,
    };
  }

  function makeAdapter(): CodexAdapter {
    return new CodexAdapter(runner, {
      executable,
      launcherArgs: [fixturePath("fake-codex.mjs")],
    });
  }

  it("advertises the codex descriptor", () => {
    const adapter = makeAdapter();

    expect(adapter.descriptor).toEqual({ id: "codex", capabilities: [] });
  });

  it("invokes the fake CLI with deterministic arguments in the supplied worktree and delivers the ContextPack", async () => {
    const adapter = makeAdapter();
    const result = await adapter.invoke(makeInvocation());

    expect(result.kind).toBe("success");
    const report = JSON.parse(
      result.kind === "success" ? (result.output.stdout ?? "") : "",
    ) as FakeAgentReport;
    expect(report.argv.slice(0, 5)).toEqual([
      "exec",
      "--sandbox",
      "workspace-write",
      "--model",
      "provider/test-model",
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
      expect(result.failure.message).toContain("codex exited with code 3");
      expect(result.output.stderr).toBe("");
    }
  });

  it("normalizes timeout through the ProcessRunner", async () => {
    process.env.FAKE_AGENT_DELAY_MS = "2000";
    const adapter = makeAdapter();
    const result = await adapter.invoke(makeInvocation({ timeoutMs: 200 }));

    expect(result.kind).toBe("timeout");
    if (result.kind === "timeout") {
      expect(result.durationMs).toBeGreaterThan(0);
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
    ).rejects.toThrow(CodexAdapterError);
    await expect(
      adapter.invoke(makeInvocation({ worktreePath: "" })),
    ).rejects.toThrow(CodexAdapterError);
  });

  it("fails with an adapter failure when the executable cannot start", async () => {
    const missing = join(spacedDir, "missing codex.exe");
    const adapter = new CodexAdapter(runner, { executable: missing });
    const result = await adapter.invoke(makeInvocation());

    expect(result.kind).toBe("failure");
    if (result.kind === "failure") {
      expect(result.failure.kind).toBe("adapter");
      expect(result.failure.message).toContain("failed to start codex");
    }
  });

  it("falls back to adapter configuration when the invocation has no model", async () => {
    const adapter = new CodexAdapter(runner, {
      executable,
      launcherArgs: [fixturePath("fake-codex.mjs")],
      model: "provider/fallback-model",
    });
    const result = await adapter.invoke(
      makeInvocation({ agent: { id: "codex" } }),
    );

    expect(result.kind).toBe("success");
    const report = JSON.parse(
      result.kind === "success" ? (result.output.stdout ?? "") : "",
    ) as FakeAgentReport;
    expect(report.argv.slice(0, 4)).toEqual([
      "exec",
      "--sandbox",
      "workspace-write",
      "--model",
    ]);
    expect(report.argv).toContain("provider/fallback-model");
  });

  it("omits the model flag when no model is configured anywhere", async () => {
    const adapter = new CodexAdapter(runner, {
      executable,
      launcherArgs: [fixturePath("fake-codex.mjs")],
    });
    const result = await adapter.invoke(
      makeInvocation({ agent: { id: "codex" } }),
    );

    expect(result.kind).toBe("success");
    const report = JSON.parse(
      result.kind === "success" ? (result.output.stdout ?? "") : "",
    ) as FakeAgentReport;
    expect(report.argv).toEqual([
      "exec",
      "--sandbox",
      "workspace-write",
      expect.any(String),
    ]);
    expect(report.argv).not.toContain("--model");
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
    const missing = join(spacedDir, "missing codex.exe");
    const adapter = new CodexAdapter(runner, { executable: missing });
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
    const adapter = new CodexAdapter(runner, {
      executable,
      launcherArgs: [fixturePath("fake-codex.mjs")],
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
    const missing = join(spacedDir, "missing codex.exe");
    const adapter = new CodexAdapter(runner, {
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

const SMOKE_ENABLED = process.env.AGENTIC_CODEX_SMOKE === "1";

describe.skipIf(!SMOKE_ENABLED)("Codex real CLI smoke test", () => {
  it("detects the installed codex CLI", async () => {
    const runner = createNodeProcessRunner();
    const version = await runner.run({
      executable: "codex",
      args: ["--version"],
    });
    if (
      version.outcome.kind === "spawn-error" &&
      version.outcome.code === "ENOENT"
    ) {
      throw new Error(
        "AGENTIC_CODEX_SMOKE is enabled but codex was not found on PATH",
      );
    }
    expect(version.outcome).toEqual({ kind: "completed", code: 0 });
    expect(version.stdout.trim().length).toBeGreaterThan(0);
  });
});
