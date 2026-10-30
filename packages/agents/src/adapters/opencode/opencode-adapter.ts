import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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

// opencode 2.x removed `--pure` and only exposes agents injected through
// OPENCODE_CONFIG to a private `--standalone` server; 1.x still requires
// `--pure`. An undetectable version falls back to the legacy 1.x contract.
const CLI_V2_MAJOR = 2;
const DEFAULT_CLI_MAJOR = 1;

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
  private majorVersionProbe: Promise<number | null> | undefined;
  private cliMajorVersion: Promise<number> | undefined;

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
      const readOnlyAgentName = invocation.readOnly === true
        ? `agentic-readonly-${randomUUID()}`
        : undefined;
      const cliMajorVersion = readOnlyAgentName === undefined
        ? undefined
        : await this.detectCliMajorVersion();
      const configPath = readOnlyAgentName === undefined ? undefined : join(contextDir, "opencode.json");
      if (readOnlyAgentName !== undefined && configPath !== undefined) {
        await writeFile(configPath, readOnlyAgentConfig(readOnlyAgentName), { encoding: "utf8", mode: 0o600, flag: "wx" });
      }

      const spec: ProcessSpec = {
        executable: this.options.executable ?? DEFAULT_EXECUTABLE,
        args: [
          ...(this.options.launcherArgs ?? []),
          ...buildRunArgs({
            model: invocation.agent.model ?? this.options.model,
            prompt: buildPrompt(contextPackPath, invocation.instruction),
            readOnlyAgentName,
            cliMajorVersion,
          }),
        ],
        cwd: invocation.worktreePath,
        ...(configPath === undefined ? {} : { env: { ...inheritedEnvironment(), OPENCODE_CONFIG: configPath } }),
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

  // The installed CLI version cannot change while the adapter runs, so the
  // probe result is cached per adapter instance.
  private detectCliMajorVersion(): Promise<number> {
    this.cliMajorVersion ??= this.readCliMajorVersion();
    return this.cliMajorVersion;
  }

  private async readCliMajorVersion(): Promise<number> {
    const spec: ProcessSpec = {
      executable: this.options.executable ?? DEFAULT_EXECUTABLE,
      args: [...(this.options.launcherArgs ?? []), ...PROBE_ARGS],
      timeoutMs: AGENT_PROBE_TIMEOUT_MS,
    };
    try {
      const result = await this.runner.run(spec);
      if (result.outcome.kind !== "completed" || result.outcome.code !== 0) {
        return DEFAULT_CLI_MAJOR;
      }
      const version = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      // Live 2.x output is "opencode v2.2.0"; the "v" is part of the word, so
      // no word boundary is used.
      const match = /(\d+)\.\d+(?:\.\d+)?/.exec(version);
      return match === null ? DEFAULT_CLI_MAJOR : Number(match[1]);
    } catch {
      return DEFAULT_CLI_MAJOR;
    }
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
  readOnlyAgentName?: string | undefined;
  cliMajorVersion?: number | undefined;
}): string[] {
  const args = ["run"];
  if (input.readOnlyAgentName !== undefined) {
    const readOnlyFlags = (input.cliMajorVersion ?? DEFAULT_CLI_MAJOR) >= CLI_V2_MAJOR
      ? ["--standalone"]
      : ["--pure"];
    args.push(...readOnlyFlags, "--agent", input.readOnlyAgentName);
  }
  if (input.model !== undefined) {
    args.push("--model", input.model);
  }
  args.push(input.prompt);
  return args;
}

function readOnlyAgentConfig(name: string): string {
  return `${JSON.stringify({ agent: { [name]: {
    description: "Read-only planning agent",
    mode: "primary",
    permission: { edit: "deny", bash: "deny", task: "deny", skill: "deny" },
  } } }, null, 2)}\n`;
}

function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
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
