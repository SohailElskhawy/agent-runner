import { copyFileSync, linkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeProcessRunner, type ProcessResult, type ProcessRunner } from "@agentic-dev-runner/platform";
import {
  CODEX_AGENT_ID,
  CodexAdapter,
  OPENCODE_AGENT_ID,
  OpenCodeAdapter,
  createAgentRegistry,
  type AgentProbeOutcome,
} from "../src/index.js";

const SPACED_DIR_PREFIX = "agentic agents m076a spaced dir ";

function placeExecutableCopy(target: string): void {
  try {
    linkSync(process.execPath, target);
  } catch {
    copyFileSync(process.execPath, target);
  }
}

class StaticProcessRunner implements ProcessRunner {
  constructor(private readonly result: ProcessResult) {}
  async run(): Promise<ProcessResult> {
    return this.result;
  }
}

class ThrowingProcessRunner implements ProcessRunner {
  async run(): Promise<ProcessResult> {
    throw new Error("runner exploded");
  }
}

class FakeDiscoverable {
  constructor(
    readonly descriptor: { id: string },
    private readonly outcome: AgentProbeOutcome | Error,
  ) {}

  async probeAvailability(): Promise<AgentProbeOutcome> {
    if (this.outcome instanceof Error) {
      throw this.outcome;
    }
    return this.outcome;
  }
}

const available = (version: string | null): AgentProbeOutcome => ({
  available: true,
  version,
  reason: null,
});

const unavailable = (reason: string): AgentProbeOutcome => ({
  available: false,
  version: null,
  reason,
});

describe("AgentRegistry discovery", () => {
  it("reports both agents as available with versions in registration order", async () => {
    const registry = createAgentRegistry([
      new FakeDiscoverable({ id: "opencode" }, available("opencode 1.2.3")),
      new FakeDiscoverable({ id: "codex" }, available("codex-cli 4.5.6")),
    ]);

    const result = await registry.discoverAgents();

    expect(result).toEqual([
      { id: "opencode", available: true, version: "opencode 1.2.3", reason: null },
      { id: "codex", available: true, version: "codex-cli 4.5.6", reason: null },
    ]);
    expect(registry.agentIds).toEqual(["opencode", "codex"]);
  });

  it("reports one available agent alongside one unavailable agent", async () => {
    const registry = createAgentRegistry([
      new FakeDiscoverable({ id: "opencode" }, available("opencode 1.2.3")),
      new FakeDiscoverable({ id: "codex" }, unavailable("codex could not be started")),
    ]);

    const result = await registry.discoverAgents();

    expect(result).toEqual([
      { id: "opencode", available: true, version: "opencode 1.2.3", reason: null },
      {
        id: "codex",
        available: false,
        version: null,
        reason: "codex could not be started",
      },
    ]);
  });

  it("reports both agents as unavailable without failing", async () => {
    const registry = createAgentRegistry([
      new FakeDiscoverable({ id: "opencode" }, unavailable("opencode missing")),
      new FakeDiscoverable({ id: "codex" }, unavailable("codex missing")),
    ]);

    const result = await registry.discoverAgents();

    expect(result.map((agent) => agent.available)).toEqual([false, false]);
    expect(result.map((agent) => agent.reason)).toEqual([
      "opencode missing",
      "codex missing",
    ]);
  });

  it("normalizes a throwing probe as unavailable and keeps other agents reportable", async () => {
    const registry = createAgentRegistry([
      new FakeDiscoverable({ id: "opencode" }, new Error("probe exploded")),
      new FakeDiscoverable({ id: "codex" }, available("codex-cli 4.5.6")),
    ]);

    const result = await registry.discoverAgents();

    expect(result[0]).toEqual({
      id: "opencode",
      available: false,
      version: null,
      reason: "probe exploded",
    });
    expect(result[1]?.available).toBe(true);
  });

  it("preserves deterministic registration order regardless of probe completion order", async () => {
    let releaseSecond: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const slowProbe = {
      descriptor: { id: "opencode" },
      async probeAvailability(): Promise<AgentProbeOutcome> {
        await gate;
        return available("opencode 0.1.0");
      },
    };
    const fastProbe = {
      descriptor: { id: "codex" },
      async probeAvailability(): Promise<AgentProbeOutcome> {
        return available("codex 0.2.0");
      },
    };
    const registry = createAgentRegistry([slowProbe, fastProbe]);
    const pending = registry.discoverAgents();
    releaseSecond?.();
    const result = await pending;

    expect(result.map((agent) => agent.id)).toEqual(["opencode", "codex"]);
  });
});

describe("Agent availability probes", () => {
  let runner: ProcessRunner;
  let spacedDir: string;
  let executable: string;
  let fakeProbePath: string;

  beforeEach(() => {
    runner = createNodeProcessRunner();
    spacedDir = mkdtempSync(join(tmpdir(), SPACED_DIR_PREFIX));
    executable = join(spacedDir, "fake agent node copy.exe");
    placeExecutableCopy(executable);
    fakeProbePath = join(spacedDir, "fake probe with spaces.mjs");
    copyFileSync(
      new URL("./fixtures/fake-probe.mjs", import.meta.url),
      fakeProbePath,
    );
  });

  afterEach(() => {
    rmSync(spacedDir, { recursive: true, force: true });
    delete process.env.FAKE_AGENT_EXIT_CODE;
    delete process.env.FAKE_PROBE_VERSION;
  });

  it("OpenCodeAdapter detects availability and captures the version", async () => {
    process.env.FAKE_PROBE_VERSION = "opencode 9.8.7";
    const adapter = new OpenCodeAdapter(runner, {
      executable,
      launcherArgs: [fakeProbePath],
    });

    const outcome = await adapter.probeAvailability();

    expect(outcome).toEqual({
      available: true,
      version: "opencode 9.8.7",
      reason: null,
    });
  });

  it("CodexAdapter detects availability and captures the version", async () => {
    process.env.FAKE_PROBE_VERSION = "codex-cli 0.5.0";
    const adapter = new CodexAdapter(runner, {
      executable,
      launcherArgs: [fakeProbePath],
    });

    const outcome = await adapter.probeAvailability();

    expect(outcome).toEqual({
      available: true,
      version: "codex-cli 0.5.0",
      reason: null,
    });
  });

  it("normalizes executable-not-found as unavailable without throwing", async () => {
    const missing = join(spacedDir, "missing opencode.exe");
    const adapter = new OpenCodeAdapter(runner, { executable: missing });

    const outcome = await adapter.probeAvailability();

    expect(outcome.available).toBe(false);
    expect(outcome.version).toBeNull();
    expect(outcome.reason).toContain("opencode could not be started");
    expect(outcome.reason).toContain("ENOENT");
  });

  it("normalizes a non-zero probe exit as unavailable without throwing", async () => {
    process.env.FAKE_AGENT_EXIT_CODE = "3";
    const adapter = new CodexAdapter(runner, {
      executable,
      launcherArgs: [fakeProbePath],
    });

    const outcome = await adapter.probeAvailability();

    expect(outcome).toEqual({
      available: false,
      version: null,
      reason: "codex version probe exited with code 3",
    });
  });

  it("normalizes timeout, termination, and cancellation outcomes as unavailable", async () => {
    const timeoutAdapter = new OpenCodeAdapter(
      new StaticProcessRunner({
        outcome: { kind: "timeout" },
        stdout: "",
        stderr: "",
        durationMs: 5,
      }),
    );
    const terminatedAdapter = new CodexAdapter(
      new StaticProcessRunner({
        outcome: { kind: "terminated", signal: "SIGKILL" },
        stdout: "",
        stderr: "",
        durationMs: 5,
      }),
    );
    const cancelledAdapter = new OpenCodeAdapter(
      new StaticProcessRunner({
        outcome: { kind: "cancelled" },
        stdout: "",
        stderr: "",
        durationMs: 0,
      }),
    );

    expect(await timeoutAdapter.probeAvailability()).toEqual({
      available: false,
      version: null,
      reason: "opencode version probe timed out",
    });
    expect(await terminatedAdapter.probeAvailability()).toEqual({
      available: false,
      version: null,
      reason: "codex version probe was terminated by signal SIGKILL",
    });
    expect(await cancelledAdapter.probeAvailability()).toEqual({
      available: false,
      version: null,
      reason: "opencode version probe was cancelled",
    });
  });

  it("probes use the version flag and never run a coding session", async () => {
    const seen: string[][] = [];
    const recordingRunner: ProcessRunner = {
      async run(spec) {
        seen.push([spec.executable, ...(spec.args ?? [])]);
        return {
          outcome: { kind: "completed", code: 0 },
          stdout: "opencode 1.0.0\n",
          stderr: "",
          durationMs: 1,
        };
      },
    };
    const adapter = new OpenCodeAdapter(recordingRunner);

    await adapter.probeAvailability();

    expect(seen).toEqual([["opencode", "--version"]]);
  });

  it("keeps discovery working when one adapter runner is broken", async () => {
    const brokenAdapter = new CodexAdapter(new ThrowingProcessRunner());
    const healthyAdapter = new OpenCodeAdapter(runner, {
      executable,
      launcherArgs: [fakeProbePath],
    });
    const registry = createAgentRegistry([brokenAdapter, healthyAdapter]);

    const result = await registry.discoverAgents();

    expect(result.map((agent) => agent.id)).toEqual([CODEX_AGENT_ID, OPENCODE_AGENT_ID]);
    expect(result[0]?.available).toBe(false);
    expect(result[1]?.available).toBe(true);
  });
});
