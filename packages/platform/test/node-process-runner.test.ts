import { copyFileSync, linkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createNodeProcessRunner,
  ProcessSpecError,
  type ProcessRunner,
} from "../src/index.js";

const SPACED_DIR_PREFIX = "agentic runner vs005 spaced dir ";

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

describe("NodeProcessRunner", () => {
  let runner: ProcessRunner;
  let spacedDir: string;

  beforeEach(() => {
    runner = createNodeProcessRunner();
    spacedDir = mkdtempSync(join(tmpdir(), SPACED_DIR_PREFIX));
  });

  afterEach(() => {
    rmSync(spacedDir, { recursive: true, force: true });
  });

  it("runs a process to completion and captures stdout and stderr", async () => {
    const result = await runner.run({
      executable: process.execPath,
      args: [fixturePath("stdio.mjs")],
    });

    expect(result.outcome).toEqual({ kind: "completed", code: 0 });
    const context = JSON.parse(result.stdout) as {
      argv: string[];
    };
    expect(context.argv).toEqual([]);
    expect(result.stderr).toBe("stderr-marker");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports non-zero exit codes deterministically", async () => {
    const result = await runner.run({
      executable: process.execPath,
      args: [fixturePath("exit-with.mjs"), "3"],
    });

    expect(result.outcome).toEqual({ kind: "completed", code: 3 });
  });

  it("passes arguments verbatim, including spaces and shell metacharacters", async () => {
    const args = [
      "hello world",
      "value with 'single quotes'",
      'value with "double quotes"',
      "1 && echo INJECTED_OUTPUT",
    ];

    const result = await runner.run({
      executable: process.execPath,
      args: [fixturePath("stdio.mjs"), ...args],
    });

    expect(result.outcome).toEqual({ kind: "completed", code: 0 });
    const context = JSON.parse(result.stdout) as { argv: string[] };
    expect(context.argv).toEqual(args);
  });

  it("runs an executable whose path contains spaces", async () => {
    const spacedExecutable = join(spacedDir, "node runner copy.exe");
    placeExecutableCopy(spacedExecutable);
    const spacedScript = join(spacedDir, "stdio copy.mjs");
    copyFileSync(fixturePath("stdio.mjs"), spacedScript);

    const result = await runner.run({
      executable: spacedExecutable,
      args: [spacedScript, "argument with spaces"],
    });

    expect(result.outcome).toEqual({ kind: "completed", code: 0 });
    const context = JSON.parse(result.stdout) as { argv: string[] };
    expect(context.argv).toEqual(["argument with spaces"]);
  });

  it("honors a working directory whose path contains spaces", async () => {
    const result = await runner.run({
      executable: process.execPath,
      args: [fixturePath("stdio.mjs")],
      cwd: spacedDir,
    });

    expect(result.outcome).toEqual({ kind: "completed", code: 0 });
    const context = JSON.parse(result.stdout) as { cwd: string };
    expect(context.cwd).toBe(spacedDir);
  });

  it("times out and terminates a long-running process", async () => {
    const result = await runner.run({
      executable: process.execPath,
      args: [fixturePath("wait.mjs"), "60000"],
      timeoutMs: 250,
    });

    expect(result.outcome).toEqual({ kind: "timeout" });
    expect(result.durationMs).toBeGreaterThanOrEqual(250);
    expect(result.durationMs).toBeLessThan(10000);
  });

  it("cancels a running process through an AbortSignal", async () => {
    const controller = new AbortController();
    const runPromise = runner.run({
      executable: process.execPath,
      args: [fixturePath("wait.mjs"), "60000"],
      signal: controller.signal,
    });

    await delay(150);
    controller.abort();
    const result = await runPromise;

    expect(result.outcome).toEqual({ kind: "cancelled" });
    expect(result.durationMs).toBeLessThan(10000);
  });

  it("returns a cancelled result without spawning for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runner.run({
      executable: process.execPath,
      args: [fixturePath("wait.mjs"), "60000"],
      signal: controller.signal,
    });

    expect(result.outcome).toEqual({ kind: "cancelled" });
    expect(result.durationMs).toBeLessThan(50);
  });

  it("propagates a custom environment variable to the child", async () => {
    const result = await runner.run({
      executable: process.execPath,
      args: [fixturePath("stdio.mjs")],
      env: { PROCESS_RUNNER_PROBE: "probe-value-42" },
    });

    expect(result.outcome).toEqual({ kind: "completed", code: 0 });
    const context = JSON.parse(result.stdout) as { probe: string | null };
    expect(context.probe).toBe("probe-value-42");
  });

  it("uses the provided environment without leaking parent variables", async () => {
    process.env.PROCESS_RUNNER_PARENT_ONLY = "parent-secret";
    try {
      const result = await runner.run({
        executable: process.execPath,
        args: [fixturePath("stdio.mjs")],
        env: { PROCESS_RUNNER_PROBE: "only-var" },
      });

      expect(result.outcome).toEqual({ kind: "completed", code: 0 });
      const context = JSON.parse(result.stdout) as {
        probe: string | null;
        parentOnly: string | null;
      };
      expect(context.probe).toBe("only-var");
      expect(context.parentOnly).toBeNull();
    } finally {
      delete process.env.PROCESS_RUNNER_PARENT_ONLY;
    }
  });

  it("inherits the parent environment when no environment is provided", async () => {
    const result = await runner.run({
      executable: process.execPath,
      args: [fixturePath("stdio.mjs")],
    });

    expect(result.outcome).toEqual({ kind: "completed", code: 0 });
    const context = JSON.parse(result.stdout) as { pathPresent: boolean };
    expect(context.pathPresent).toBe(
      (process.env.PATH ?? process.env.Path) === undefined ? false : true,
    );
  });

  it("resolves a bare executable name through PATH without a shell", async () => {
    const result = await runner.run({
      executable: "node",
      args: [fixturePath("exit-with.mjs"), "0"],
    });

    expect(result.outcome).toEqual({ kind: "completed", code: 0 });
  });

  it("reports spawn failure as a deterministic spawn-error outcome", async () => {
    const result = await runner.run({
      executable: "definitely-not-a-real-executable-vs005",
      args: [],
    });

    expect(result.outcome.kind).toBe("spawn-error");
    const outcome = result.outcome;
    if (outcome.kind !== "spawn-error") {
      throw new Error(`expected spawn-error, received ${outcome.kind}`);
    }
    expect(outcome.code).toBe("ENOENT");
    expect(outcome.message.length).toBeGreaterThan(0);
  });

  it("rejects invalid process specifications", async () => {
    await expect(
      runner.run({ executable: "" }),
    ).rejects.toThrow(ProcessSpecError);
    await expect(
      runner.run({ executable: process.execPath, timeoutMs: 0 }),
    ).rejects.toThrow(ProcessSpecError);
    await expect(
      runner.run({ executable: process.execPath, killGraceMs: -1 }),
    ).rejects.toThrow(ProcessSpecError);
  });

  it("supports multiple sequential runs through the same runner", async () => {
    const first = await runner.run({
      executable: process.execPath,
      args: [fixturePath("exit-with.mjs"), "0"],
    });
    const second = await runner.run({
      executable: process.execPath,
      args: [fixturePath("exit-with.mjs"), "2"],
    });

    expect(first.outcome).toEqual({ kind: "completed", code: 0 });
    expect(second.outcome).toEqual({ kind: "completed", code: 2 });
  });
});

const windowsOnly = it.skipIf(process.platform !== "win32");

windowsOnly("spawns .cmd shims on PATH with argument fidelity", async () => {
  const fixtureDir = fileURLToPath(new URL("./fixtures", import.meta.url));
  const runner = createNodeProcessRunner();
  const args = [
    "plain",
    "with space",
    'with "quotes"',
    "ampersand & pipe | char",
    "caret ^ and parens ( )",
  ];
  const result = await runner.run({
    executable: "shim-args.cmd",
    args,
    env: { ...process.env, PATH: `${fixtureDir}${delimiter}${process.env.PATH ?? ""}` },
  });
  expect(result.outcome).toEqual({ kind: "completed", code: 0 });
  expect(JSON.parse(result.stdout)).toEqual(args);
});
