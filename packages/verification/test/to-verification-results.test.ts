import { describe, expect, it } from "vitest";
import type { VerificationResult } from "@agentic-dev-runner/core";
import type { ProcessResult } from "@agentic-dev-runner/platform";
import {
  createVerificationEngine,
  toVerificationResults,
  type VerificationRunResult,
} from "../src/index.js";

const RUNNING_ENGINE = createVerificationEngine({
  runner: {
    run: (): Promise<ProcessResult> =>
      Promise.resolve({
        outcome: { kind: "completed", code: 0 },
        stdout: "",
        stderr: "",
        durationMs: 1,
      }),
  },
  resultIdFactory: () => "fixed-id",
});

function makeRun(
  overrides: Partial<VerificationRunResult> = {},
): VerificationRunResult {
  return {
    attemptId: "attempt-1",
    cwd: "/worktrees/task-1",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:10.000Z",
    checks: [],
    status: "PASSED",
    passed: true,
    cancelled: false,
    ...overrides,
  };
}

describe("toVerificationResults", () => {
  it("maps a passing check into the core VerificationResult contract", async () => {
    const run = await RUNNING_ENGINE.run({
      attemptId: "attempt-42",
      cwd: "/worktrees/task-1",
      checks: [{ name: "typecheck", executable: "pnpm", args: ["typecheck"] }],
    });

    const results: VerificationResult[] = toVerificationResults(run);

    expect(results).toHaveLength(1);
    const first = results[0];
    expect(first).toEqual({
      id: run.checks[0]?.id,
      attemptId: "attempt-42",
      kind: "typecheck",
      command: ["pnpm", "typecheck"],
      outcome: "PASSED",
      exitCode: 0,
      startedAt: run.checks[0]?.startedAt,
      finishedAt: run.checks[0]?.finishedAt,
    });
  });

  it("maps a failing check with failure details", async () => {
    const engine = createVerificationEngine({
      runner: {
        run: (): Promise<ProcessResult> =>
          Promise.resolve({
            outcome: { kind: "completed", code: 1 },
            stdout: "some out",
            stderr: "some err",
            durationMs: 7,
          }),
      },
      resultIdFactory: () => "ver-1",
    });

    const run = await engine.run({
      attemptId: "attempt-42",
      cwd: "/worktrees/task-1",
      checks: [{ name: "unit", executable: "pnpm" }],
    });

    const results = toVerificationResults(run);
    const first = results[0];
    expect(first?.outcome).toBe("FAILED");
    expect(first?.exitCode).toBe(1);
    expect(first?.finishedAt).toBe(run.checks[0]?.finishedAt);
    expect(first?.failure).toEqual({
      message: 'verification command "unit" exited with code 1',
      output: "some out\nsome err",
    });
  });

  it("maps a check cancelled before it started onto the run timestamps", async () => {
    const run = makeRun({
      status: "CANCELLED",
      passed: false,
      cancelled: true,
      checks: [
        {
          id: "ver-1",
          attemptId: "attempt-1",
          name: "unit",
          kind: "custom",
          command: ["pnpm"],
          outcome: "CANCELLED",
          stdout: "",
          stderr: "",
          durationMs: 0,
          startedAt: undefined,
          finishedAt: undefined,
          failure: { message: "cancelled before start" },
        },
      ],
    });

    const results = toVerificationResults(run);
    const first = results[0];
    expect(first?.startedAt).toBe(run.startedAt);
    expect("finishedAt" in (first ?? {})).toBe(false);
    expect(first?.failure).toEqual({ message: "cancelled before start" });
  });

  it("keeps one distinct id per check", async () => {
    let counter = 0;
    const engine = createVerificationEngine({
      runner: {
        run: (): Promise<ProcessResult> =>
          Promise.resolve({
            outcome: { kind: "completed", code: 0 },
            stdout: "",
            stderr: "",
            durationMs: 1,
          }),
      },
      resultIdFactory: () => `ver_${String((counter += 1))}`,
    });

    const run = await engine.run({
      attemptId: "attempt-1",
      cwd: "/worktrees/task-1",
      checks: [
        { name: "typecheck", executable: "pnpm" },
        { name: "unit", executable: "pnpm" },
      ],
    });

    const results = toVerificationResults(run);
    expect(results.map((item) => item.id)).toEqual(["ver_1", "ver_2"]);
  });

  it("produces JSON-serializable run data", async () => {
    const engine = createVerificationEngine({
      runner: {
        run: (): Promise<ProcessResult> =>
          Promise.resolve({
            outcome: { kind: "completed", code: 1 },
            stdout: "out",
            stderr: "err",
            durationMs: 3,
          }),
      },
      resultIdFactory: () => "ver-1",
    });

    const run = await engine.run({
      attemptId: "attempt-1",
      cwd: "/worktrees/task-1",
      checks: [{ name: "unit", executable: "pnpm" }],
    });

    const parsed = JSON.parse(JSON.stringify(run)) as VerificationRunResult;
    expect(parsed).toEqual(run);
    expect(JSON.parse(JSON.stringify(toVerificationResults(run)))).toEqual(
      toVerificationResults(run),
    );
  });
});

