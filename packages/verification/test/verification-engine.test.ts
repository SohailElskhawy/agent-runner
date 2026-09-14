import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ProcessResult,
  ProcessRunner,
  ProcessSpec,
} from "@agentic-dev-runner/platform";
import {
  createNodeProcessRunner,
} from "@agentic-dev-runner/platform";
import {
  createVerificationEngine,
  DEFAULT_FAIL_FAST,
  DEFAULT_MAX_OUTPUT_CHARS,
  VerificationSpecError,
  type VerificationCheckSpec,
  type VerificationRunInput,
} from "../src/index.js";

const FIXTURE = fileURLToPath(
  new URL("./fixtures/fake-check.mjs", import.meta.url),
);

const LONG_OUTPUT =
  "01234567890123456789012345678901234567890123456789" +
  "01234567890123456789012345678901234567890123456789";

type FakeScript = (spec: ProcessSpec, index: number) => ProcessResult;

class FakeRunner implements ProcessRunner {
  readonly specs: ProcessSpec[] = [];
  private readonly script: FakeScript;

  constructor(script: FakeScript) {
    this.script = script;
  }

  run(spec: ProcessSpec): Promise<ProcessResult> {
    this.specs.push(spec);
    return Promise.resolve(this.script(spec, this.specs.length - 1));
  }
}

function completed(code: number, overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    outcome: { kind: "completed", code },
    stdout: "",
    stderr: "",
    durationMs: 1,
    ...overrides,
  };
}

function countingIdFactory(prefix: string): () => string {
  let counter = 0;
  return () => `${prefix}_${String((counter += 1))}`;
}

function check(
  name: string,
  executable: string,
  extra: Partial<VerificationCheckSpec> = {},
): VerificationCheckSpec {
  return { name, executable, ...extra };
}

function baseInput(
  overrides: Partial<VerificationRunInput> = {},
): VerificationRunInput {
  return {
    attemptId: "attempt-1",
    cwd: "/worktrees/task-1",
    checks: [],
    ...overrides,
  };
}

function samePath(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

async function withEnv(
  values: Record<string, string>,
  body: () => Promise<void>,
): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    await body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

const SPACED_DIR_PREFIX = "agentic vs010 worktree with spaces ";
const PLAIN_DIR_PREFIX = "agentic-vs010-worktree-";

let tempDirs: string[] = [];

function makeTempWorktree(prefix: string): string {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("verification engine", () => {
  it("runs a single passing command and reports a passed aggregate", async () => {
    const runner = new FakeRunner(() =>
      completed(0, { stdout: "ok", stderr: "", durationMs: 12 }),
    );
    const engine = createVerificationEngine({
      runner,
      resultIdFactory: countingIdFactory("ver"),
    });

    const result = await engine.run(
      baseInput({
        checks: [check("typecheck", "pnpm", { args: ["typecheck"] })],
      }),
    );

    expect(result.status).toBe("PASSED");
    expect(result.passed).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(result.checks).toHaveLength(1);
    const first = result.checks[0];
    expect(first).toMatchObject({
      id: "ver_1",
      attemptId: "attempt-1",
      name: "typecheck",
      kind: "typecheck",
      command: ["pnpm", "typecheck"],
      outcome: "PASSED",
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      durationMs: 12,
    });
    expect(first?.startedAt).toBeDefined();
    expect(first?.finishedAt).toBeDefined();
    expect(first?.failure).toBeUndefined();
    expect(result.startedAt).toBeDefined();
    expect(result.finishedAt).toBeDefined();
    expect(runner.specs[0]).toEqual({
      executable: "pnpm",
      args: ["typecheck"],
      cwd: "/worktrees/task-1",
      timeoutMs: undefined,
      signal: undefined,
    });
  });

  it("marks a non-zero exit as failed verification", async () => {
    const engine = createVerificationEngine({
      runner: new FakeRunner(() => completed(2)),
      resultIdFactory: countingIdFactory("ver"),
    });

    const result = await engine.run(
      baseInput({ checks: [check("unit", "pnpm", { args: ["test"] })] }),
    );

    expect(result.status).toBe("FAILED");
    expect(result.passed).toBe(false);
    expect(result.cancelled).toBe(false);
    const first = result.checks[0];
    expect(first?.outcome).toBe("FAILED");
    expect(first?.exitCode).toBe(2);
    expect(first?.failure?.message).toContain('exited with code 2');
  });

  it("captures stdout and stderr of each check", async () => {
    const engine = createVerificationEngine({
      runner: new FakeRunner(() =>
        completed(0, { stdout: "standard out", stderr: "standard err" }),
      ),
      resultIdFactory: countingIdFactory("ver"),
    });

    const result = await engine.run(
      baseInput({ checks: [check("build", "tsc")] }),
    );

    expect(result.checks[0]?.stdout).toBe("standard out");
    expect(result.checks[0]?.stderr).toBe("standard err");
  });

  it("runs multiple checks deterministically in configured order", async () => {
    const runner = new FakeRunner((_spec, index) =>
      completed(0, { stdout: `ran-${String(index)}` }),
    );
    const engine = createVerificationEngine({
      runner,
      resultIdFactory: countingIdFactory("ver"),
    });

    const result = await engine.run(
      baseInput({
        checks: [
          check("typecheck", "pnpm", { args: ["typecheck"] }),
          check("unit", "pnpm", { args: ["test"] }),
          check("build", "tsc"),
        ],
      }),
    );

    expect(runner.specs.map((spec) => spec.executable)).toEqual([
      "pnpm",
      "pnpm",
      "tsc",
    ]);
    expect(runner.specs.map((spec) => spec.args)).toEqual([
      ["typecheck"],
      ["test"],
      undefined,
    ]);
    expect(result.checks.map((item) => item.stdout)).toEqual([
      "ran-0",
      "ran-1",
      "ran-2",
    ]);
    expect(result.status).toBe("PASSED");
  });

  it("fails the aggregate when any required check fails", async () => {
    const engine = createVerificationEngine({
      runner: new FakeRunner((_spec, index) => completed(index === 1 ? 1 : 0)),
      resultIdFactory: countingIdFactory("ver"),
      failFast: false,
    });

    const result = await engine.run(
      baseInput({
        checks: [check("typecheck", "pnpm"), check("unit", "pnpm"), check("build", "tsc")],
      }),
    );

    expect(result.status).toBe("FAILED");
    expect(result.passed).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(result.checks).toHaveLength(3);
    expect(result.checks.map((item) => item.outcome)).toEqual([
      "PASSED",
      "FAILED",
      "PASSED",
    ]);
  });

  it("stops after the first failed check by default (fail-fast)", async () => {
    const runner = new FakeRunner((_spec, index) =>
      completed(index === 0 ? 1 : 0),
    );
    const engine = createVerificationEngine({
      runner,
      resultIdFactory: countingIdFactory("ver"),
    });

    const result = await engine.run(
      baseInput({
        checks: [check("typecheck", "pnpm"), check("unit", "pnpm")],
      }),
    );

    expect(runner.specs).toHaveLength(1);
    expect(result.checks).toHaveLength(1);
    expect(result.status).toBe("FAILED");
    expect(result.passed).toBe(false);
    expect(result.cancelled).toBe(false);
  });

  it("continues after a failed check when failFast is disabled", async () => {
    const runner = new FakeRunner((_spec, index) =>
      completed(index === 0 ? 1 : 0),
    );
    const engine = createVerificationEngine({
      runner,
      resultIdFactory: countingIdFactory("ver"),
      failFast: false,
    });

    const result = await engine.run(
      baseInput({
        checks: [check("typecheck", "pnpm"), check("unit", "pnpm")],
      }),
    );

    expect(runner.specs).toHaveLength(2);
    expect(result.checks).toHaveLength(2);
    expect(result.status).toBe("FAILED");
  });

  it("normalizes a timeout outcome as a failed check", async () => {
    const engine = createVerificationEngine({
      runner: new FakeRunner(() => completed(0, { outcome: { kind: "timeout" } })),
      resultIdFactory: countingIdFactory("ver"),
    });

    const result = await engine.run(
      baseInput({
        checks: [
          check("unit", "pnpm", { args: ["test"], timeoutMs: 50 }),
        ],
      }),
    );

    expect(result.status).toBe("FAILED");
    const first = result.checks[0];
    expect(first?.outcome).toBe("FAILED");
    expect("exitCode" in (first ?? {})).toBe(false);
    expect(first?.failure?.message).toContain("timed out after 50 ms");
  });

  it("normalizes a cancelled outcome as a cancelled run", async () => {
    const engine = createVerificationEngine({
      runner: new FakeRunner(() => completed(0, { outcome: { kind: "cancelled" } })),
      resultIdFactory: countingIdFactory("ver"),
    });

    const result = await engine.run(
      baseInput({
        checks: [check("unit", "pnpm"), check("build", "tsc")],
      }),
    );

    expect(result.status).toBe("CANCELLED");
    expect(result.cancelled).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]?.outcome).toBe("CANCELLED");
    expect(result.checks[0]?.failure?.message).toContain("was cancelled");
  });

  it("normalizes a signal-terminated process as a failed check", async () => {
    const engine = createVerificationEngine({
      runner: new FakeRunner(() =>
        completed(0, { outcome: { kind: "terminated", signal: "SIGKILL" } }),
      ),
      resultIdFactory: countingIdFactory("ver"),
    });

    const result = await engine.run(
      baseInput({ checks: [check("unit", "pnpm")] }),
    );

    expect(result.status).toBe("FAILED");
    const first = result.checks[0];
    expect(first?.outcome).toBe("FAILED");
    expect(first?.failure?.message).toContain("terminated by signal SIGKILL");
  });

  it("normalizes a spawn error as a failed check", async () => {
    const engine = createVerificationEngine({
      runner: new FakeRunner(() =>
        completed(0, {
          outcome: { kind: "spawn-error", code: "ENOENT", message: "not found" },
        }),
      ),
      resultIdFactory: countingIdFactory("ver"),
    });

    const result = await engine.run(
      baseInput({ checks: [check("unit", "definitely-missing-executable")] }),
    );

    expect(result.status).toBe("FAILED");
    const first = result.checks[0];
    expect(first?.outcome).toBe("FAILED");
    expect("exitCode" in (first ?? {})).toBe(false);
    expect(first?.failure?.message).toContain("ENOENT");
    expect(first?.failure?.message).toContain("not found");
  });

  it("resolves the verification kind from the check name with explicit override", async () => {
    const engine = createVerificationEngine({
      runner: new FakeRunner(() => completed(0)),
      resultIdFactory: countingIdFactory("ver"),
    });

    const result = await engine.run(
      baseInput({
        checks: [
          check("lint", "pnpm"),
          check("pnpm test", "pnpm"),
          check("smoke suite", "node", { kind: "integration" }),
        ],
      }),
    );

    expect(result.checks.map((item) => item.kind)).toEqual([
      "lint",
      "custom",
      "integration",
    ]);
  });

  it("applies the configured output limit to captured output", async () => {
    const engine = createVerificationEngine({
      runner: new FakeRunner(() =>
        completed(1, { stdout: LONG_OUTPUT, stderr: LONG_OUTPUT }),
      ),
      resultIdFactory: countingIdFactory("ver"),
      maxOutputChars: 10,
    });

    const result = await engine.run(
      baseInput({ checks: [check("unit", "pnpm")] }),
    );

    const first = result.checks[0];
    expect(first?.stdout).toBe(
      "0123456789\n[verification output truncated: 90 chars omitted]",
    );
    expect(first?.stderr).toBe(
      "0123456789\n[verification output truncated: 90 chars omitted]",
    );
    expect(first?.failure?.output).toBe(`${first?.stdout}\n${first?.stderr}`);
    expect(first?.failure?.output).not.toContain("4567890123456789");
  });

  it("uses sensible default engine options", () => {
    expect(DEFAULT_FAIL_FAST).toBe(true);
    expect(DEFAULT_MAX_OUTPUT_CHARS).toBe(200_000);
  });

  it("rejects invalid run input", async () => {
    const engine = createVerificationEngine({
      runner: new FakeRunner(() => completed(0)),
      resultIdFactory: countingIdFactory("ver"),
    });

    const invalid: VerificationRunInput[] = [
      baseInput({ attemptId: "" }),
      baseInput({ cwd: "" }),
      baseInput({ checks: [check("", "pnpm")] }),
      baseInput({ checks: [check("unit", "")] }),
      baseInput({ checks: [check("unit", "pnpm", { args: ["ok", 3] as unknown as string[] })] }),
      baseInput({ checks: [check("unit", "pnpm", { kind: "nope" as unknown as "custom" })] }),
      baseInput({ checks: [check("unit", "pnpm", { timeoutMs: 0 })] }),
    ];

    for (const input of invalid) {
      await expect(engine.run(input)).rejects.toBeInstanceOf(VerificationSpecError);
    }
  });

  it("rejects invalid engine options", () => {
    const runner = new FakeRunner(() => completed(0));

    expect(() =>
      createVerificationEngine({
        runner,
        maxOutputChars: 0,
      }),
    ).toThrow(VerificationSpecError);
    expect(() =>
      createVerificationEngine({
        runner,
        failFast: "yes" as unknown as boolean,
      }),
    ).toThrow(VerificationSpecError);
  });

  it("runs a passing command end-to-end through the node process runner", async () => {
    const engine = createVerificationEngine({
      runner: createNodeProcessRunner(),
      resultIdFactory: countingIdFactory("ver"),
    });
    const worktree = makeTempWorktree(PLAIN_DIR_PREFIX);

    await withEnv({ FAKE_CHECK_MARKER: "vs010-pass" }, async () => {
      const result = await engine.run(
        baseInput({
          cwd: worktree,
          checks: [check("typecheck", process.execPath, { args: [FIXTURE] })],
        }),
      );

      expect(result.status).toBe("PASSED");
      const first = result.checks[0];
      expect(first?.exitCode).toBe(0);
      const payload = JSON.parse(first?.stdout ?? "{}") as {
        argv: string[];
        marker: string;
      };
      expect(payload.argv).toEqual([]);
      expect(payload.marker).toBe("vs010-pass");
    });
  }, 10_000);

  it("captures real stdout, stderr, and non-zero exit codes", async () => {
    const engine = createVerificationEngine({
      runner: createNodeProcessRunner(),
      resultIdFactory: countingIdFactory("ver"),
    });
    const worktree = makeTempWorktree(PLAIN_DIR_PREFIX);

    await withEnv(
      { FAKE_CHECK_EXIT: "3", FAKE_CHECK_STDERR: "boom" },
      async () => {
        const result = await engine.run(
          baseInput({
            cwd: worktree,
            checks: [check("unit", process.execPath, { args: [FIXTURE] })],
          }),
        );

        expect(result.status).toBe("FAILED");
        const first = result.checks[0];
        expect(first?.outcome).toBe("FAILED");
        expect(first?.exitCode).toBe(3);
        expect(first?.stderr).toBe("boom");
        expect(first?.failure?.output).toContain("boom");
        expect(first?.failure?.message).toContain("exited with code 3");
      },
    );
  }, 10_000);

  it("executes checks inside a worktree path containing spaces", async () => {
    const worktree = makeTempWorktree(SPACED_DIR_PREFIX);
    const engine = createVerificationEngine({
      runner: createNodeProcessRunner(),
      resultIdFactory: countingIdFactory("ver"),
    });

    await withEnv({ FAKE_CHECK_MARKER: "cwd-check" }, async () => {
      const result = await engine.run(
        baseInput({
          cwd: worktree,
          checks: [check("build", process.execPath, { args: [FIXTURE] })],
        }),
      );

      expect(result.status).toBe("PASSED");
      const payload = JSON.parse(result.checks[0]?.stdout ?? "{}") as {
        cwd: string;
      };
      expect(samePath(payload.cwd, worktree)).toBe(true);
    });
  }, 10_000);

  it("passes configured args verbatim without shell interpretation", async () => {
    const engine = createVerificationEngine({
      runner: createNodeProcessRunner(),
      resultIdFactory: countingIdFactory("ver"),
    });
    const worktree = makeTempWorktree(PLAIN_DIR_PREFIX);
    const args = [
      "--greeting",
      "hello world",
      "a && b",
      "$(echo pwned)",
      "semi;colon",
      "pipe|char",
      "%PATH%",
    ];

    const result = await engine.run(
      baseInput({
        cwd: worktree,
        checks: [
          check("smoke suite", process.execPath, { args: [FIXTURE, ...args] }),
        ],
      }),
    );

    expect(result.status).toBe("PASSED");
    const payload = JSON.parse(result.checks[0]?.stdout ?? "{}") as {
      argv: string[];
    };
    expect(payload.argv).toEqual(args);
  }, 10_000);

  it("fails the check when the executable cannot be spawned", async () => {
    const engine = createVerificationEngine({
      runner: createNodeProcessRunner(),
      resultIdFactory: countingIdFactory("ver"),
    });
    const worktree = makeTempWorktree(PLAIN_DIR_PREFIX);

    const result = await engine.run(
      baseInput({
        cwd: worktree,
        checks: [check("unit", "agentic-dev-runner-missing-executable")],
      }),
    );

    expect(result.status).toBe("FAILED");
    const first = result.checks[0];
    expect(first?.outcome).toBe("FAILED");
    expect(first?.failure?.message).toContain("failed to start");
  }, 10_000);

  it("times out a long-running check and reports failure", async () => {
    const engine = createVerificationEngine({
      runner: createNodeProcessRunner(),
      resultIdFactory: countingIdFactory("ver"),
    });
    const worktree = makeTempWorktree(PLAIN_DIR_PREFIX);

    await withEnv({ FAKE_CHECK_DELAY_MS: "5000" }, async () => {
      const result = await engine.run(
        baseInput({
          cwd: worktree,
          checks: [
            check("unit", process.execPath, {
              args: [FIXTURE],
              timeoutMs: 100,
            }),
          ],
        }),
      );

      expect(result.status).toBe("FAILED");
      const first = result.checks[0];
      expect(first?.outcome).toBe("FAILED");
      expect(first?.failure?.message).toContain("timed out after 100 ms");
      expect(first?.durationMs).toBeLessThan(5000);
    });
  }, 10_000);

  it("cancels a running check when the signal aborts mid-flight", async () => {
    const engine = createVerificationEngine({
      runner: createNodeProcessRunner(),
      resultIdFactory: countingIdFactory("ver"),
    });
    const worktree = makeTempWorktree(PLAIN_DIR_PREFIX);
    const controller = new AbortController();

    await withEnv({ FAKE_CHECK_DELAY_MS: "5000" }, async () => {
      const pending = engine.run(
        baseInput({
          cwd: worktree,
          checks: [check("unit", process.execPath, { args: [FIXTURE] })],
          signal: controller.signal,
        }),
      );
      await delay(200);
      controller.abort();
      const result = await pending;

      expect(result.status).toBe("CANCELLED");
      expect(result.cancelled).toBe(true);
      expect(result.passed).toBe(false);
      const first = result.checks[0];
      expect(first?.outcome).toBe("CANCELLED");
      expect(first?.failure?.message).toContain("was cancelled");
    });
  }, 15_000);

  it("cancels the run before starting when the signal is already aborted", async () => {
    const runner = new FakeRunner(() => completed(0));
    const engine = createVerificationEngine({
      runner,
      resultIdFactory: countingIdFactory("ver"),
    });
    const controller = new AbortController();
    controller.abort();

    const result = await engine.run(
      baseInput({
        checks: [check("unit", "pnpm")],
        signal: controller.signal,
      }),
    );

    expect(runner.specs).toHaveLength(0);
    expect(result.status).toBe("CANCELLED");
    expect(result.cancelled).toBe(true);
    expect(result.checks).toHaveLength(0);
  });
});
