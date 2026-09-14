import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProcessRunner } from "@agentic-dev-runner/platform";
import type {
  AgentDescriptor,
  AgentExecutionResult,
  AgentInvocation,
  AgentRuntime,
} from "@agentic-dev-runner/agents";
import type { Attempt, Project, Task } from "@agentic-dev-runner/core";
import type { GitManager } from "@agentic-dev-runner/git";
import type {
  VerificationCheckResult,
  VerificationEngine,
  VerificationRunInput,
  VerificationRunResult,
} from "@agentic-dev-runner/verification";

export const AGENTS_MARKDOWN = "# Fixture rules\n\nBe precise.\n";

export function createProject(overrides?: {
  id?: string;
  rootPath?: string;
}): Project {
  return {
    id: overrides?.id ?? "proj-1",
    name: "fixture-project",
    rootPath: overrides?.rootPath ?? "fixtures/project",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

export function createTask(overrides?: {
  id?: string;
  projectId?: string;
  status?: Task["status"];
}): Task {
  return {
    id: overrides?.id ?? "M001",
    projectId: overrides?.projectId ?? "proj-1",
    title: "Add a small utility function",
    milestone: "milestone-1",
    status: overrides?.status ?? "READY",
    type: "implementation",
    priority: "P0",
    risk: "low",
    definition: {
      objective: "Add one validated utility function.",
      acceptanceCriteria: ["Valid input returns expected output."],
      scope: {
        allowedPaths: ["src/**"],
        forbiddenPaths: ["docs/**"],
      },
      resources: ["utils"],
      verification: { required: ["typecheck", "unit"] },
      limits: { maxAttempts: 3, maxReviewCycles: 2 },
      approval: { required: false },
    },
    routing: {
      complexity: "small",
      capabilities: ["typescript"],
    },
    provenance: { kind: "user_request", source: "manual" },
    dependsOn: [],
    workflow: "default",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

export type AgentBehavior = (
  invocation: AgentInvocation,
) => AgentExecutionResult | Promise<AgentExecutionResult>;

export class FakeAgentRuntime implements AgentRuntime {
  readonly descriptor: AgentDescriptor;
  readonly invocations: AgentInvocation[] = [];

  constructor(
    private readonly behavior?: AgentBehavior | undefined,
    descriptor?: Partial<AgentDescriptor> | undefined,
  ) {
    this.descriptor = {
      id: descriptor?.id ?? "fake-agent",
      ...(descriptor?.model === undefined
        ? {}
        : { model: descriptor.model }),
    };
  }

  async invoke(invocation: AgentInvocation): Promise<AgentExecutionResult> {
    this.invocations.push(invocation);
    if (this.behavior === undefined) {
      return { kind: "success", output: {}, exitCode: 0, durationMs: 0 };
    }
    return await this.behavior(invocation);
  }
}

export function agentAppliesChange(change: {
  readonly path: string;
  readonly content: string;
}): AgentBehavior {
  return (invocation) => {
    writeFileSync(join(invocation.worktreePath, change.path), change.content);
    return {
      kind: "success",
      output: { stdout: `wrote ${change.path}`, stderr: "" },
      exitCode: 0,
      durationMs: 5,
    };
  };
}

export function agentFails(message: string): AgentBehavior {
  return () => ({
    kind: "failure",
    failure: { kind: "process", message },
    output: { stdout: "partial output", stderr: message },
    durationMs: 5,
  });
}

export function agentTimesOut(): AgentBehavior {
  return () => ({
    kind: "timeout",
    output: { stdout: "still running" },
    durationMs: 60_000,
  });
}

export function agentIsCancelled(): AgentBehavior {
  return () => ({
    kind: "cancelled",
    output: { stdout: "" },
    durationMs: 10,
  });
}

export type VerificationResponse = (
  input: VerificationRunInput,
) => VerificationRunResult;

export class FakeVerificationEngine implements VerificationEngine {
  readonly runs: VerificationRunInput[] = [];

  constructor(private readonly respond: VerificationResponse) {}

  async run(input: VerificationRunInput): Promise<VerificationRunResult> {
    this.runs.push(input);
    return this.respond(input);
  }
}

const FIXTURE_STARTED_AT = "2026-01-01T00:00:00.000Z";
const FIXTURE_FINISHED_AT = "2026-01-01T00:00:01.000Z";

function fixtureCheckBase(
  input: VerificationRunInput,
  name: string,
): VerificationCheckResult {
  return {
    id: `ver_${name}`,
    attemptId: input.attemptId,
    name,
    kind: "custom",
    command: ["node", "-e", "0"],
    outcome: "PASSED",
    stdout: "",
    stderr: "",
    durationMs: 1,
    startedAt: FIXTURE_STARTED_AT,
    finishedAt: FIXTURE_FINISHED_AT,
  };
}

export function passedVerificationRun(
  input: VerificationRunInput,
): VerificationRunResult {
  return {
    attemptId: input.attemptId,
    cwd: input.cwd,
    startedAt: FIXTURE_STARTED_AT,
    finishedAt: FIXTURE_FINISHED_AT,
    checks: input.checks.map((check) => fixtureCheckBase(input, check.name)),
    status: "PASSED",
    passed: true,
    cancelled: false,
  };
}

export function failedVerificationRun(
  input: VerificationRunInput,
  failingCheckName: string,
  message: string,
): VerificationRunResult {
  return {
    attemptId: input.attemptId,
    cwd: input.cwd,
    startedAt: FIXTURE_STARTED_AT,
    finishedAt: FIXTURE_FINISHED_AT,
    checks: input.checks.map((check) => {
      if (check.name !== failingCheckName) {
        return fixtureCheckBase(input, check.name);
      }
      return {
        ...fixtureCheckBase(input, check.name),
        outcome: "FAILED" as const,
        exitCode: 1,
        failure: { message, output: `${check.name} failed` },
      };
    }),
    status: "FAILED",
    passed: false,
    cancelled: false,
  };
}

export function cancelledVerificationRun(
  input: VerificationRunInput,
): VerificationRunResult {
  return {
    attemptId: input.attemptId,
    cwd: input.cwd,
    startedAt: FIXTURE_STARTED_AT,
    finishedAt: FIXTURE_FINISHED_AT,
    checks: input.checks.map((check) => ({
      ...fixtureCheckBase(input, check.name),
      outcome: "CANCELLED" as const,
    })),
    status: "CANCELLED",
    passed: false,
    cancelled: true,
  };
}

export function injectGitFailures(
  inner: GitManager,
  failures: Partial<Record<string, () => Error>>,
): GitManager {
  return new Proxy(inner, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      const fail = failures[String(property)];
      if (typeof value !== "function" || fail === undefined) {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return () => Promise.reject(fail());
    },
  });
}

export async function runFixtureGit(
  runner: ProcessRunner,
  cwd: string,
  args: string[],
): Promise<string> {
  const result = await runner.run({ executable: "git", args, cwd });
  if (result.outcome.kind !== "completed" || result.outcome.code !== 0) {
    throw new Error(
      `fixture git command failed: git ${args.join(" ")}: ${result.stderr}`,
    );
  }
  return result.stdout;
}

export async function createFixtureRepository(options: {
  runner: ProcessRunner;
  repositoryPath: string;
  agentsMarkdown: string;
}): Promise<string> {
  mkdirSync(options.repositoryPath, { recursive: true });
  const run = (args: string[]) =>
    runFixtureGit(options.runner, options.repositoryPath, args);
  await run(["init"]);
  await run(["config", "user.email", "runner@example.com"]);
  await run(["config", "user.name", "Agentic Runner Tests"]);
  await run(["config", "core.autocrlf", "false"]);
  writeFileSync(join(options.repositoryPath, "AGENTS.md"), options.agentsMarkdown);
  writeFileSync(join(options.repositoryPath, "README.md"), "fixture\n");
  await run(["add", "."]);
  await run(["commit", "-m", "initial commit"]);
  const head = await run(["rev-parse", "HEAD"]);
  return head.trim();
}

export function findAttempt(
  attempts: readonly Attempt[],
  attemptId: string,
): Attempt {
  const attempt = attempts.find((candidate) => candidate.id === attemptId);
  if (attempt === undefined) {
    throw new Error(`attempt "${attemptId}" not found`);
  }
  return attempt;
}
