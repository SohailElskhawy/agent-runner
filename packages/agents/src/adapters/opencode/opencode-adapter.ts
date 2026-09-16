import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessOutcome, ProcessResult, ProcessRunner, ProcessSpec } from "@agentic-dev-runner/platform";
import { stableStringify } from "@agentic-dev-runner/context";
import type {
  AgentDescriptor,
  AgentInvocation,
  AgentRuntime,
} from "../../runtime/agent-runtime.js";
import type {
  AgentExecutionResult,
  AgentOutput,
} from "../../runtime/agent-result.js";
import {
  AGENT_PROBE_TIMEOUT_MS,
  normalizeProbeResult,
} from "../../discovery/agent-probe.js";
import type { AgentProbeOutcome } from "../../discovery/agent-availability.js";

export const OPENCODE_AGENT_ID = "opencode";

const DEFAULT_EXECUTABLE = "opencode";
const PROBE_ARGS = ["--version"];
const CONTEXT_DIR_PREFIX = "agentic-opencode-context-";
const CONTEXT_FILE_NAME = "context-pack.json";

export type OpenCodeAdapterOptions = {
  readonly executable?: string | undefined;
  readonly model?: string | undefined;
  readonly launcherArgs?: readonly string[] | undefined;
  readonly removeDirectory?: ContextDirectoryRemover | undefined;
};

export type ContextDirectoryRemover = (path: string) => Promise<void>;

export class OpenCodeAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenCodeAdapterError";
  }
}

export class OpenCodeAdapter implements AgentRuntime {
  readonly descriptor: AgentDescriptor = {
    id: OPENCODE_AGENT_ID,
    capabilities: [],
  };

  private readonly runner: ProcessRunner;
  private readonly options: OpenCodeAdapterOptions;
  private readonly removeDirectory: ContextDirectoryRemover;

  constructor(runner: ProcessRunner, options: OpenCodeAdapterOptions = {}) {
    this.runner = runner;
    this.options = options;
    this.removeDirectory = options.removeDirectory ?? removeContextDir;
  }

  async invoke(invocation: AgentInvocation): Promise<AgentExecutionResult> {
    if (invocation.worktreePath.length === 0) {
      throw new OpenCodeAdapterError("worktreePath must be a non-empty string");
    }
    if (!Number.isFinite(invocation.timeoutMs) || invocation.timeoutMs <= 0) {
      throw new OpenCodeAdapterError("timeoutMs must be a positive finite number");
    }

    const contextDir = await mkdtemp(join(tmpdir(), CONTEXT_DIR_PREFIX));
    try {
      const contextPackPath = join(contextDir, CONTEXT_FILE_NAME);
      await writeFile(
        contextPackPath,
        stableStringify(invocation.contextPack),
        { encoding: "utf8", mode: 0o600 },
      );

      const spec: ProcessSpec = {
        executable: this.options.executable ?? DEFAULT_EXECUTABLE,
        args: [
          ...(this.options.launcherArgs ?? []),
          ...buildRunArgs({
            model: invocation.agent.model ?? this.options.model,
            prompt: buildPrompt(contextPackPath, invocation.instruction),
          }),
        ],
        cwd: invocation.worktreePath,
        timeoutMs: invocation.timeoutMs,
        signal: invocation.signal,
      };

      return normalizeResult(await this.runner.run(spec));
    } finally {
      await runCleanup(this.removeDirectory, contextDir);
    }
  }

  async probeAvailability(): Promise<AgentProbeOutcome> {
    const spec: ProcessSpec = {
      executable: this.options.executable ?? DEFAULT_EXECUTABLE,
      args: [...(this.options.launcherArgs ?? []), ...PROBE_ARGS],
      timeoutMs: AGENT_PROBE_TIMEOUT_MS,
    };
    return normalizeProbeResult(await this.runner.run(spec), OPENCODE_AGENT_ID);
  }
}

async function runCleanup(
  removeDirectory: ContextDirectoryRemover,
  path: string,
): Promise<void> {
  try {
    await removeDirectory(path);
  } catch {
    return;
  }
}

async function removeContextDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

function buildRunArgs(input: {
  model?: string | undefined;
  prompt: string;
}): string[] {
  const args = ["run"];
  if (input.model !== undefined) {
    args.push("--model", input.model);
  }
  args.push(input.prompt);
  return args;
}

function buildPrompt(
  contextPackPath: string,
  instruction?: string | undefined,
): string {
  const base = `Read the task context pack at "${contextPackPath}" and complete the task it describes.`;
  return instruction === undefined ? base : `${base} ${instruction}`;
}

function normalizeResult(result: ProcessResult): AgentExecutionResult {
  const output: AgentOutput = {
    stdout: result.stdout,
    stderr: result.stderr,
  };
  const outcome: ProcessOutcome = result.outcome;
  switch (outcome.kind) {
    case "completed":
      if (outcome.code === 0) {
        return {
          kind: "success",
          output,
          exitCode: 0,
          durationMs: result.durationMs,
        };
      }
      return {
        kind: "failure",
        failure: {
          kind: "process",
          message: `${OPENCODE_AGENT_ID} exited with code ${outcome.code}`,
        },
        output,
        durationMs: result.durationMs,
      };
    case "terminated":
      return {
        kind: "failure",
        failure: {
          kind: "process",
          message: `${OPENCODE_AGENT_ID} was terminated by signal ${outcome.signal}`,
        },
        output,
        durationMs: result.durationMs,
      };
    case "timeout":
      return { kind: "timeout", output, durationMs: result.durationMs };
    case "cancelled":
      return { kind: "cancelled", output, durationMs: result.durationMs };
    case "spawn-error":
      return {
        kind: "failure",
        failure: {
          kind: "adapter",
          message: `failed to start ${OPENCODE_AGENT_ID} (${outcome.code}): ${outcome.message}`,
        },
        output,
        durationMs: result.durationMs,
      };
  }
}
