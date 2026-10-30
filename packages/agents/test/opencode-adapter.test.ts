import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
    spacedDir = realpathSync(mkdtempSync(join(tmpdir(), SPACED_DIR_PREFIX)));
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
    delete process.env.FAKE_AGENT_VERSION;
  });

  function makeRecordingAdapter(record: {
    argvs: string[][];
    envs: (Record<string, string> | undefined)[];
  }): OpenCodeAdapter {
    const launcherArgs: readonly string[] = [fixturePath("fake-opencode.mjs")];
    const inspectingRunner: ProcessRunner = {
      run: async (spec) => {
        const args = [...(spec.args ?? [])];
        record.argvs.push(args.slice(launcherArgs.length));
        record.envs.push(spec.env === undefined ? undefined : { ...spec.env });
        return runner.run(spec);
      },
    };
    return new OpenCodeAdapter(inspectingRunner, {
      executable,
      launcherArgs,
    });
  }

  function countVersionProbes(record: {
    argvs: string[][];
  }): number {
    return record.argvs.filter((argv) => argv.includes("--version")).length;
  }

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

  it("loads and cleans a unique read-only agent without overwriting project OpenCode config", async () => {
    process.env.FAKE_AGENT_VERSION = "1.18.33";
    const configDir = join(worktreePath, ".opencode");
    mkdirSync(configDir, { recursive: true });
    const projectConfig = join(configDir, "opencode.json");
    writeFileSync(projectConfig, '{"model":"project/model"}');
    const configPaths: string[] = [];
    const agentNames: string[] = [];
    let args: readonly string[] = [];
    const inspectingRunner: ProcessRunner = {
      run: async (spec) => {
        if (spec.args?.includes("--version")) {
          return runner.run(spec);
        }
        args = spec.args ?? [];
        const index = args.indexOf("--agent");
        const name = args[index + 1] ?? "";
        const configPath = spec.env?.["OPENCODE_CONFIG"] ?? "";
        configPaths.push(configPath);
        agentNames.push(name);
        expect(configPath).not.toContain(worktreePath);
        expect(spec.env?.["PATH"]).toBe(process.env.PATH);
        const config = JSON.parse(readFileSync(configPath, "utf8")) as { agent: Record<string, { permission: Record<string, string> }> };
        expect(config.agent[name]?.permission).toEqual({ edit: "deny", bash: "deny", task: "deny", skill: "deny" });
        return runner.run(spec);
      },
    };
    const adapter = new OpenCodeAdapter(inspectingRunner, {
      executable,
      launcherArgs: [fixturePath("fake-opencode.mjs")],
    });
    expect((await adapter.invoke(makeInvocation({ readOnly: true }))).kind).toBe("success");
    expect((await adapter.invoke(makeInvocation({ readOnly: true }))).kind).toBe("success");
    expect(args).toContain("--pure");
    expect(args).toContain("--agent");
    expect(new Set(agentNames).size).toBe(2);
    expect(readFileSync(projectConfig, "utf8")).toBe('{"model":"project/model"}');
    expect(configPaths.every((path) => !existsSync(path))).toBe(true);
    expect(existsSync(join(worktreePath, ".opencode", "agents"))).toBe(false);
  });

  it("keeps --pure and probes the CLI major version once for read-only 1.x invocations", async () => {
    process.env.FAKE_AGENT_VERSION = "1.99.0";
    const record: { argvs: string[][]; envs: (Record<string, string> | undefined)[] } = { argvs: [], envs: [] };
    const adapter = makeRecordingAdapter(record);
    const result = await adapter.invoke(makeInvocation({ readOnly: true }));

    expect(result.kind).toBe("success");
    const report = JSON.parse(
      result.kind === "success" ? (result.output.stdout ?? "") : "",
    ) as FakeAgentReport;
    expect(report.argv).toEqual([
      "run",
      "--pure",
      "--agent",
      expect.any(String),
      "--model",
      "provider/test-model",
      expect.any(String),
    ]);
    expect(countVersionProbes(record)).toBe(1);
  });

  it("reproduces AR048: opencode 2.x rejects --pure with Unrecognized flag", async () => {
    process.env.FAKE_AGENT_VERSION = "2.2.0";
    const strict = await runner.run({
      executable,
      args: [fixturePath("fake-opencode.mjs"), "run", "--pure", "--agent", "agentic-readonly-x", "prompt"],
    });
    expect(strict.outcome.kind).toBe("completed");
    expect(strict.outcome.kind === "completed" ? strict.outcome.code : 0).toBe(1);
    expect(strict.stderr).toContain("Unrecognized flag: --pure");
  });

  it("reproduces AR048: opencode 2.x reports Agent not found without the standalone server", async () => {
    process.env.FAKE_AGENT_VERSION = "2.2.0";
    const strict = await runner.run({
      executable,
      args: [fixturePath("fake-opencode.mjs"), "run", "--agent", "agentic-readonly-x", "prompt"],
    });
    expect(strict.outcome.kind).toBe("completed");
    expect(strict.outcome.kind === "completed" ? strict.outcome.code : 0).toBe(1);
    expect(strict.stderr).toContain(`Agent not found: "agentic-readonly-x"`);
  });

  it("on opencode 2.x uses --standalone with no --pure and still injects the read-only agent via OPENCODE_CONFIG", async () => {
    process.env.FAKE_AGENT_VERSION = "2.2.0";
    const argvs: string[][] = [];
    const configs: { path: string; content: string }[] = [];
    const inspectingRunner: ProcessRunner = {
      run: async (spec) => {
        const args = [...(spec.args ?? [])];
        argvs.push(args.slice(1));
        const configPath = spec.env?.["OPENCODE_CONFIG"] ?? "";
        if (configPath.length > 0) {
          configs.push({ path: configPath, content: readFileSync(configPath, "utf8") });
        }
        return runner.run(spec);
      },
    };
    const adapter = new OpenCodeAdapter(inspectingRunner, {
      executable,
      launcherArgs: [fixturePath("fake-opencode.mjs")],
    });
    expect((await adapter.invoke(makeInvocation({ readOnly: true }))).kind).toBe("success");
    expect((await adapter.invoke(makeInvocation({ readOnly: true }))).kind).toBe("success");

    // The per-adapter major-version detect runs one --version probe.
    expect(argvs.filter((entry) => entry.includes("--version"))).toHaveLength(1);
    const argv = argvs.filter((entry) => entry.includes("run")).at(-1) ?? [];
    expect(argv[0]).toBe("run");
    expect(argv).not.toContain("--pure");
    expect(argv).toContain("--standalone");
    const agentIndex = argv.indexOf("--agent");
    const name = argv[agentIndex + 1] ?? "";
    expect(name).toMatch(/^agentic-readonly-/);
    expect(argv).toContain("--model");
    expect(argv.at(-1)).not.toBe("--model");
    const injected = configs.filter((entry) => entry.path.includes("agentic-opencode-context-"));
    expect(injected).toHaveLength(2);
    const config = JSON.parse(injected.at(-1)?.content ?? "{}") as {
      agent: Record<string, { description?: string; mode?: string; permission: Record<string, string> }>;
    };
    expect(config.agent[name]).toEqual({
      description: "Read-only planning agent",
      mode: "primary",
      permission: { edit: "deny", bash: "deny", task: "deny", skill: "deny" },
    });
    // The temp config directory is removed once the run completes.
    expect(existsSync(injected.at(-1)?.path ?? "")).toBe(false);
    const agentNames = argvs
      .filter((entry) => entry.includes("--agent"))
      .map((entry) => entry[entry.indexOf("--agent") + 1]);
    expect(new Set(agentNames).size).toBe(2);
  });

  it("treats an unparseable opencode version as the legacy 1.x contract", async () => {
    process.env.FAKE_AGENT_VERSION = "not-a-version";
    const record: { argvs: string[][]; envs: (Record<string, string> | undefined)[] } = { argvs: [], envs: [] };
    const adapter = makeRecordingAdapter(record);
    const result = await adapter.invoke(makeInvocation({ readOnly: true }));

    expect(result.kind).toBe("success");
    const report = JSON.parse(
      result.kind === "success" ? (result.output.stdout ?? "") : "",
    ) as FakeAgentReport;
    expect(report.argv).toContain("--pure");
    expect(report.argv).not.toContain("--standalone");
  });

  it("reproduces AR048: opencode 2.x rejects --pure with Unrecognized flag", async () => {
    process.env.FAKE_AGENT_VERSION = "2.2.0";
    const record: { argvs: string[][]; envs: (Record<string, string> | undefined)[] } = {
      argvs: [],
      envs: [],
    };
    const adapter = makeRecordingAdapter(record);
    const result = await adapter.invoke(makeInvocation());

    expect(result.kind).toBe("success");
    const runArgv = record.argvs.at(-1) ?? [];
    expect(runArgv.slice(0, 3)).toEqual(["run", "--model", "provider/test-model"]);
    expect(runArgv).not.toContain("--pure");
    expect(runArgv).not.toContain("--standalone");
    expect(runArgv).not.toContain("--agent");
    expect(record.argvs.filter((entry) => entry.includes("--version"))).toHaveLength(0);
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
    process.env.FAKE_AGENT_DELAY_MS = "60000";
    const adapter = makeAdapter();
    const result = await adapter.invoke(makeInvocation({ timeoutMs: 200 }));

    expect(result.kind).toBe("timeout");
    if (result.kind === "timeout") {
      expect(result.durationMs).toBeLessThan(60000);
      expect(result.output.stdout).toBe("");
    }
  });

  it("normalizes cancellation through the ProcessRunner", async () => {
    process.env.FAKE_AGENT_DELAY_MS = "60000";
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

  it.skipIf(process.platform !== "win32")(
    "probes availability through a .cmd launcher shim on Windows",
    async () => {
      const adapter = new OpenCodeAdapter(runner, {
        executable: fixturePath("fake-opencode.cmd"),
      });

      expect(await adapter.probeAvailability()).toEqual({
        available: true,
        version: "fake opencode 1.0.0",
        reason: null,
      });
    },
  );
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
