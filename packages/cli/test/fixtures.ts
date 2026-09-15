import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attempt, Project, Task } from "@agentic-dev-runner/core";
import type { AgentDescriptor, AgentExecutionResult, AgentInvocation, AgentRuntime } from "@agentic-dev-runner/agents";
import type { VerificationEngine, VerificationRunInput, VerificationRunResult } from "@agentic-dev-runner/verification";
import { createNodeProcessRunner, type ProcessRunner } from "@agentic-dev-runner/platform";
import type { CliIo } from "../src/io.js";

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

export function createFixtureTask(overrides?: {
  id?: string;
  projectId?: string;
  status?: Task["status"];
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
    writeFileSync(join(invocation.worktreePath, "change.txt"), "change\n");
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
