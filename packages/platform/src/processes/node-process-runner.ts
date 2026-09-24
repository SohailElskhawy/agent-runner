import { spawn, type ChildProcess } from "node:child_process";
import crossSpawn from "cross-spawn";
import { performance } from "node:perf_hooks";
import { Buffer } from "node:buffer";
import type {
  ProcessOutcome,
  ProcessResult,
  ProcessRunner,
  ProcessSpec,
} from "./process-runner.js";
import { ProcessSpecError } from "./errors.js";

const DEFAULT_KILL_GRACE_MS = 5000;

export function createNodeProcessRunner(): ProcessRunner {
  return new NodeProcessRunner();
}

export class NodeProcessRunner implements ProcessRunner {
  async run(spec: ProcessSpec): Promise<ProcessResult> {
    validateSpec(spec);
    if (spec.signal?.aborted === true) {
      return {
        outcome: { kind: "cancelled" },
        stdout: "",
        stderr: "",
        durationMs: 0,
      };
    }
    return this.spawn(spec);
  }

  private spawn(spec: ProcessSpec): Promise<ProcessResult> {
    return new Promise((resolve) => {
      const started = performance.now();
      const killGraceMs = spec.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

      let timedOut = false;
      let cancelled = false;
      let settled = false;
      let sawExit = false;
      let timeoutTimer: NodeJS.Timeout | null = null;
      let forceKillTimer: NodeJS.Timeout | null = null;
      let onAbort: (() => void) | null = null;

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      const clearTimers = () => {
        if (timeoutTimer !== null) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        if (forceKillTimer !== null) {
          clearTimeout(forceKillTimer);
          forceKillTimer = null;
        }
      };

      const finish = (outcome: ProcessOutcome) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimers();
        if (onAbort !== null && spec.signal !== undefined) {
          spec.signal.removeEventListener("abort", onAbort);
          onAbort = null;
        }
        resolve({
          outcome,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          durationMs: Math.max(0, Math.round(performance.now() - started)),
        });
      };

      const spawned = trySpawn(spec);
      if (!spawned.ok) {
        finish(spawnErrorOutcome(spawned.error));
        return;
      }
      const child = spawned.child;

      const killChild = () => {
        if (child.exitCode !== null || child.signalCode !== null) {
          return;
        }
        child.kill();
        forceKillTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            return;
          }
        }, killGraceMs);
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });

      if (spec.signal !== undefined) {
        onAbort = () => {
          cancelled = true;
          killChild();
        };
        spec.signal.addEventListener("abort", onAbort, { once: true });
      }

      if (spec.timeoutMs !== undefined) {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          killChild();
        }, spec.timeoutMs);
      }

      child.on("exit", () => {
        sawExit = true;
      });

      child.on("error", (error: Error) => {
        if (timedOut || cancelled) {
          killChild();
          return;
        }
        if (!sawExit) {
          finish(spawnErrorOutcome(error));
          return;
        }
        killChild();
      });

      child.on(
        "close",
        (code: number | null, signal: NodeJS.Signals | null) => {
          if (timedOut) {
            finish({ kind: "timeout" });
            return;
          }
          if (cancelled) {
            finish({ kind: "cancelled" });
            return;
          }
          if (signal !== null) {
            finish({ kind: "terminated", signal });
            return;
          }
          if (code !== null) {
            finish({ kind: "completed", code });
            return;
          }
          finish({ kind: "terminated", signal: "unknown" });
        },
      );
    });
  }
}

type SpawnAttempt =
  | { readonly ok: true; readonly child: ChildProcess }
  | { readonly ok: false; readonly error: unknown };

function trySpawn(spec: ProcessSpec): SpawnAttempt {
  try {
    const spawnImpl = process.platform === "win32" ? crossSpawn : spawn;
    return {
      ok: true,
      child: spawnImpl(spec.executable, [...(spec.args ?? [])], {
        cwd: spec.cwd,
        env: spec.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (error) {
    return { ok: false, error };
  }
}

function spawnErrorOutcome(error: unknown): ProcessOutcome {
  const code =
    typeof (error as { code?: unknown } | null)?.code === "string"
      ? ((error as { code: string }).code as string)
      : "SPAWN_FAILED";
  const message = error instanceof Error ? error.message : String(error);
  return { kind: "spawn-error", code, message };
}

function validateSpec(spec: ProcessSpec): void {
  if (typeof spec.executable !== "string" || spec.executable.length === 0) {
    throw new ProcessSpecError("executable must be a non-empty string");
  }
  if (
    spec.timeoutMs !== undefined &&
    (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0)
  ) {
    throw new ProcessSpecError("timeoutMs must be a positive finite number");
  }
  if (
    spec.killGraceMs !== undefined &&
    (!Number.isFinite(spec.killGraceMs) || spec.killGraceMs < 0)
  ) {
    throw new ProcessSpecError("killGraceMs must be a non-negative finite number");
  }
}
