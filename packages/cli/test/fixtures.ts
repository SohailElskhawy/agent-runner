import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Attempt, Project, Task, TaskStatus } from "@agentic-dev-runner/core";
import type { AgentDescriptor, AgentExecutionResult, AgentInvocation, AgentRuntime } from "@agentic-dev-runner/agents";
import type { VerificationEngine, VerificationRunInput, VerificationRunResult } from "@agentic-dev-runner/verification";
import { createNodeProcessRunner, type ProcessRunner } from "@agentic-dev-runner/platform";
import type { CliIo } from "../src/io.js";
import type { SchedulerStatus } from "../src/application/ports.js";

export function captureIo(): { io: CliIo; lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    io: {
      writeLine: (text) => {
        lines.push(text);
      },
      writeError: (text) => {
        errors.push(text);
      },
    },
  };
}

export function createFixtureProject(overrides?: { id?: string }): Project {
  return {
    id: overrides?.id ?? "proj-local",
    name: "fixture-project",
    rootPath: "fixtures/project",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/**
 * A scheduler-aware project status fixture with sensible idle output. Fields
 * can be overridden to exercise specific scheduler states.
 */
export function createSchedulerStatus(overrides?: {
  readonly totals?: Partial<Record<TaskStatus, number>>;
  readonly activeTaskIds?: readonly string[];
  readonly failedTaskIds?: readonly string[];
  readonly blockedTaskIds?: readonly string[];
  readonly recoveryRequiredTaskIds?: readonly string[];
  readonly activeExecutions?: number;
  readonly maxParallelism?: number;
}): SchedulerStatus {
  const totals: Record<TaskStatus, number> = {
    BACKLOG: 0,
    READY: 0,
    PLANNING: 0,
    PLAN_REVIEW: 0,
    IMPLEMENTING: 0,
    CODE_REVIEW: 0,
    VERIFYING: 0,
    INTEGRATING: 0,
    DONE: 0,
    BLOCKED: 0,
    NEEDS_HUMAN: 0,
    FAILED: 0,
    CANCELLED: 0,
    ...(overrides?.totals ?? {}),
  };
  return {
    totalsByState: totals,
    activeTaskIds: overrides?.activeTaskIds ?? [],
    blockedTaskIds: overrides?.blockedTaskIds ?? [],
    failedTaskIds: overrides?.failedTaskIds ?? [],
    recoveryRequiredTaskIds: overrides?.recoveryRequiredTaskIds ?? [],
    activeClaims: [],
    recoveryRequiredClaims: [],
    integrationQueue: {
      totalsByStatus: {
        PENDING: 0,
        INTEGRATING: 0,
        COMPLETED: 0,
        FAILED: 0,
      },
      pendingTaskIds: [],
      integrating: null,
    },
    parallelCapacity: {
      maxParallelism: overrides?.maxParallelism ?? 1,
      activeExecutions: overrides?.activeExecutions ?? 0,
      remainingSlots: (overrides?.maxParallelism ?? 1) - (overrides?.activeExecutions ?? 0),
    },
  };
}

export function createFixtureTask(overrides?: {
  id?: string;
  projectId?: string;
  status?: Task["status"];
  approvalRequired?: boolean;
  approvalGrantedAt?: string;
}): Task {
  return {
    id: overrides?.id ?? "M001",
    projectId: overrides?.projectId ?? "proj-local",
    title: "Add a small utility function",
    milestone: "milestone-1",
    status: overrides?.status ?? "READY",
    type: "implementation",
    priority: "P0",
    risk: "low",
    definition: {
      objective: "Add one validated utility function.",
      acceptanceCriteria: ["Valid input returns expected output."],
      scope: { allowedPaths: ["src/**"], forbiddenPaths: [] },
      resources: [],
      verification: { required: ["typecheck", "unit"] },
      limits: { maxAttempts: 3, maxReviewCycles: 2 },
      approval: { required: overrides?.approvalRequired ?? false },
    },
    routing: { complexity: "small", capabilities: ["typescript"] },
    provenance: { kind: "user_request", source: "manual" },
    dependsOn: [],
    workflow: "default",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...(overrides?.approvalGrantedAt === undefined
      ? {}
      : { approvalGrantedAt: overrides.approvalGrantedAt }),
  };
}

export function createFixtureAttempt(overrides?: {
  id?: string;
  taskId?: string;
  number?: number;
  status?: Attempt["status"];
  baseRevision?: string;
}): Attempt {
  return {
    id: overrides?.id ?? "att_M001_1",
    taskId: overrides?.taskId ?? "M001",
    number: overrides?.number ?? 1,
    status: overrides?.status ?? "SUCCEEDED",
    agent: "fake-agent",
    baseRevision: overrides?.baseRevision ?? "abcdef1234567890",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:05.000Z",
  };
}

export class RecordingAgentRuntime implements AgentRuntime {
  readonly descriptor: AgentDescriptor = { id: "recording-agent" };
  readonly invocations: AgentInvocation[] = [];

  async invoke(invocation: AgentInvocation): Promise<AgentExecutionResult> {
    this.invocations.push(invocation);
    const target = join(invocation.worktreePath, "src", "change.txt");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "change\n");
    return { kind: "success", output: { stdout: "ok" }, exitCode: 0, durationMs: 1 };
  }
}

export class PassingVerificationEngine implements VerificationEngine {
  async run(input: VerificationRunInput): Promise<VerificationRunResult> {
    return {
      attemptId: input.attemptId,
      cwd: input.cwd,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      checks: [],
      status: "PASSED",
      passed: true,
      cancelled: false,
    };
  }
}

export async function createFixtureRepository(
  repositoryPath: string,
  agentsMarkdown: string,
): Promise<string> {
  const runner: ProcessRunner = createNodeProcessRunner();
  mkdirSync(repositoryPath, { recursive: true });
  const run = async (args: readonly string[]): Promise<string> => {
    const result = await runner.run({ executable: "git", args, cwd: repositoryPath });
    if (result.outcome.kind !== "completed" || result.outcome.code !== 0) {
      throw new Error(`fixture git command failed: git ${args.join(" ")}: ${result.stderr}`);
    }
    return result.stdout;
  };
  await run(["init"]);
  await run(["config", "user.email", "runner@example.com"]);
  await run(["config", "user.name", "Agentic Runner Tests"]);
  await run(["config", "core.autocrlf", "false"]);
  writeFileSync(join(repositoryPath, "AGENTS.md"), agentsMarkdown);
  writeFileSync(join(repositoryPath, "README.md"), "fixture\n");
  await run(["add", "."]);
  await run(["commit", "-m", "initial commit"]);
  return (await run(["rev-parse", "HEAD"])).trim();
}

export function temporaryDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

export const PROJECT_CONFIG_FILE = "agentic.yaml";

export const DEFAULT_PROJECT_CONFIG_YAML = [
  "verification:",
  "  checks:",
  "    typecheck:",
  "      command: node",
  "      args:",
  "        - --version",
  "    unit:",
  "      command: node",
  "      args:",
  "        - --version",
  "",
].join("\n");

export function writeProjectConfiguration(
  repositoryPath: string,
  yaml: string = DEFAULT_PROJECT_CONFIG_YAML,
): void {
  writeFileSync(join(repositoryPath, PROJECT_CONFIG_FILE), yaml, "utf8");
}
