/**
 * IMPLEMENT stage execution.
 *
 * Executes the `IMPLEMENT` stage of a workflow attempt by invoking the
 * selected provider-independent AgentRuntime in the task worktree with the
 * task's ContextPack and an implementation stage instruction — the agent is
 * explicitly asked to perform the implementation work itself, unlike the
 * PLAN/REVIEW stages. Optional prior-stage guidance (approved PLAN output,
 * review feedback from a prior fix cycle) is supplied through the existing
 * ContextPack infrastructure when provided.
 *
 * The stage is provider-independent: there is no OpenCode/Codex branching
 * here and no CLI involvement. The runner owns the stage: the agent result
 * is normalized, the worktree must contain usable code changes after the
 * invocation, and the IMPLEMENT StageRun is persisted through the existing
 * StageRun persistence (RUNNING before the invocation, a terminal state
 * afterwards) so the attempt's stage execution history stays durable.
 *
 * This executor never transitions task state, never marks the task DONE,
 * never stages, commits, integrates, verifies, or reviews: it is a single
 * stage execution primitive; the runner owns every authoritative decision.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AttemptId,
  ContextPack,
  IsoTimestamp,
  StageKind,
  StageRun,
  StageRunFailure,
  StageRunId,
  StageRunOutput,
  StageRunStatus,
  Task,
} from "@agentic-dev-runner/core";
import { buildContextPack } from "@agentic-dev-runner/context";
import type { AgentOutput, AgentRuntime } from "@agentic-dev-runner/agents";
import type { GitManager, GitStatus } from "@agentic-dev-runner/git";import type { RunnerStore } from "@agentic-dev-runner/persistence";
import { OrchestrationError } from "./orchestration-error.js";

const IMPLEMENT_STAGE: StageKind = "IMPLEMENT";
const PLAN_CONTEXT_DOCUMENT_PATH = "PLAN";
const REVIEW_FEEDBACK_CONTEXT_DOCUMENT_PATH = "REVIEW_FEEDBACK";

export type ImplementStageOutcome =
  | {
      readonly kind: "succeeded";
      readonly attemptId: AttemptId;
      readonly stageRun: StageRun;
      readonly changedPaths: readonly string[];
      readonly durationMs: number;
    }
  | {
      readonly kind: "failed";
      readonly attemptId: AttemptId;
      readonly stageRun: StageRun;
      readonly reason: string;
      readonly durationMs: number;
    };

/**
 * Optional prior-stage information handed to the implementation agent
 * through extra ContextPack documents: the approved PLAN output when the
 * workflow produced one, and the actionable feedback of the review that
 * requested this fix cycle.
 */
export type ImplementStageGuidance = {
  readonly plan?: string | undefined;
  readonly reviewFeedback?: string | undefined;
};

export type ImplementStageOptions = {
  readonly store: RunnerStore;
  readonly git: GitManager;
  readonly agent: AgentRuntime;
  readonly task: Task;
  readonly attemptId: AttemptId;
  readonly worktreePath: string;
  readonly baseRevision: string;
  readonly timeoutMs: number;
  /**
   * 1-based review-cycle index of this invocation within a bounded
   * review/fix loop. Each cycle persists its own StageRun identity so the
   * complete stage execution history of the attempt is preserved; the
   * default of 1 keeps the original per-attempt identity.
   */
  readonly cycle?: number | undefined;
  readonly guidance?: ImplementStageGuidance | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly now?: (() => IsoTimestamp) | undefined;
};

/**
 * The implementation stage instruction handed to the agent. Unlike the
 * PLAN/REVIEW stage instructions it explicitly requests the implementation
 * work itself, while reserving staging, commits, verification, and
 * integration for the runner; adapters render it inside their
 * provider-specific prompt.
 */
export const IMPLEMENT_STAGE_INSTRUCTION = [
  "STAGE IMPLEMENT — perform the implementation work now.",
  "Implement the task described in the context pack: create, modify, and",
  "delete project files as needed to satisfy the objective, acceptance",
  "criteria, and scope rules (AGENTS.md) within the allowed task scope.",
  "Do NOT stage or commit changes, do NOT create Git commits or branches,",
  "do NOT run verification or integration steps, and do NOT review or",
  "approve your own changes; the runner performs those stages.",
].join(" ");

/**
 * Deterministic IMPLEMENT StageRun identity for the attempt. Cycle 1 keeps
 * the original identity; later fix cycles append their cycle number so
 * repeated IMPLEMENT invocations never overwrite previous cycle history.
 */
export function implementStageRunId(
  attemptId: AttemptId,
  cycle = 1,
): StageRunId {
  return cycle <= 1
    ? `stage_${attemptId}_IMPLEMENT`
    : `stage_${attemptId}_IMPLEMENT_c${String(cycle)}`;
}

export async function executeImplementStage(
  options: ImplementStageOptions,
): Promise<ImplementStageOutcome> {
  validateOptions(options);
  const now = options.now ?? defaultClock;
  const stageRunId = implementStageRunId(options.attemptId, options.cycle);
  const startedAt = now();
  const running: StageRun = {
    id: stageRunId,
    attemptId: options.attemptId,
    stage: IMPLEMENT_STAGE,
    status: "RUNNING",
    startedAt,
  };
  try {
    await options.store.putStageRun(running);
  } catch (error) {
    throw new OrchestrationError(
      `failed to persist the RUNNING IMPLEMENT stage run "${stageRunId}" for attempt "${options.attemptId}": ${describeError(error)}`,
      error,
    );
  }

  if (options.signal?.aborted === true) {
    return finalize(options, stageRunId, startedAt, {
      status: "CANCELLED",
      failure: {
        kind: "cancelled",
        message: "the IMPLEMENT stage was cancelled",
      },
    });
  }

  try {
    return await runImplementStage(options, stageRunId, startedAt, now);
  } catch (error) {
    return finalize(options, stageRunId, startedAt, {
      status: "FAILED",
      failure: {
        kind: "error",
        message: `IMPLEMENT stage failed: ${describeError(error)}`,
      },
    });
  }
}

async function runImplementStage(
  options: ImplementStageOptions,
  stageRunId: StageRunId,
  startedAt: IsoTimestamp,
  now: () => IsoTimestamp,
): Promise<ImplementStageOutcome> {
  const contextPack = await buildImplementContextPack(options, now);
  const agentResult = await options.agent.invoke({
    agent: agentDescriptorOf(options.agent),
    contextPack,
    worktreePath: options.worktreePath,
    timeoutMs: options.timeoutMs,
    instruction: IMPLEMENT_STAGE_INSTRUCTION,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  if (agentResult.kind === "failure") {
    return finalizeWithAgentOutput(options, stageRunId, startedAt, {
      status: "FAILED",
      failure: {
        kind: "error",
        message: `agent failed: ${agentResult.failure.message}`,
      },
      output: agentResult.output,
    });
  }
  if (agentResult.kind === "timeout") {
    return finalizeWithAgentOutput(options, stageRunId, startedAt, {
      status: "TIMED_OUT",
      failure: {
        kind: "timeout",
        message: `agent invocation timed out after ${String(options.timeoutMs)} ms`,
      },
      output: agentResult.output,
    });
  }
  if (agentResult.kind === "cancelled") {
    return finalizeWithAgentOutput(options, stageRunId, startedAt, {
      status: "CANCELLED",
      failure: {
        kind: "cancelled",
        message: "agent invocation was cancelled",
      },
      output: agentResult.output,
    });
  }

  const worktreeStatus = await inspectWorktree(options);
  if (worktreeStatus.clean) {
    return finalizeWithAgentOutput(options, stageRunId, startedAt, {
      status: "FAILED",
      failure: {
        kind: "error",
        message:
          "agent produced no usable code changes: the task worktree is clean",
      },
      output: agentResult.output,
    });
  }

  return finalize(options, stageRunId, startedAt, {
    status: "SUCCEEDED",
    output: agentOutputOf(agentResult.output),
    changedPaths: worktreeStatus.entries.map((entry) => entry.path),
  });
}

type Finalization = {
  readonly status: StageRunStatus;
  readonly failure?: StageRunFailure | undefined;
  readonly output?: StageRunOutput | undefined;
  readonly changedPaths?: readonly string[] | undefined;
};

async function finalize(
  options: ImplementStageOptions,
  stageRunId: StageRunId,
  startedAt: IsoTimestamp,
  finalization: Finalization,
): Promise<ImplementStageOutcome> {
  const finishedAt = (options.now ?? defaultClock)();
  const stageRun: StageRun = {
    id: stageRunId,
    attemptId: options.attemptId,
    stage: IMPLEMENT_STAGE,
    status: finalization.status,
    startedAt,
    finishedAt,
    ...(finalization.failure === undefined
      ? {}
      : { failure: finalization.failure }),
    ...(finalization.output === undefined
      ? {}
      : { output: finalization.output }),
  };
  await persistFinalStageRun(options, stageRun);
  return finalization.status === "SUCCEEDED"
    ? {
        kind: "succeeded",
        attemptId: options.attemptId,
        stageRun,
        changedPaths: finalization.changedPaths ?? [],
        durationMs: durationBetween(startedAt, finishedAt),
      }
    : {
        kind: "failed",
        attemptId: options.attemptId,
        stageRun,
        reason: finalization.failure?.message ?? "IMPLEMENT stage failed",
        durationMs: durationBetween(startedAt, finishedAt),
      };
}

/**
 * Failure finalization that preserves the agent's normalized stdout/stderr
 * in the StageRun output so failure information stays durable.
 */
async function finalizeWithAgentOutput(
  options: ImplementStageOptions,
  stageRunId: StageRunId,
  startedAt: IsoTimestamp,
  input: {
    readonly status: StageRunStatus;
    readonly failure: StageRunFailure;
    readonly output: AgentOutput;
  },
): Promise<ImplementStageOutcome> {
  return finalize(options, stageRunId, startedAt, {
    status: input.status,
    failure: input.failure,
    output: agentOutputOf(input.output),
  });
}

function agentOutputOf(output: AgentOutput): StageRunOutput | undefined {
  const stdout = output.stdout;
  const stderr = output.stderr;
  if (stdout === undefined && stderr === undefined) {
    return undefined;
  }
  return {
    ...(stdout === undefined ? {} : { stdout }),
    ...(stderr === undefined ? {} : { stderr }),
  };
}

async function persistFinalStageRun(
  options: ImplementStageOptions,
  stageRun: StageRun,
): Promise<void> {
  try {
    await options.store.putStageRun(stageRun);
  } catch (error) {
    throw new OrchestrationError(
      `failed to persist the ${stageRun.status} IMPLEMENT stage run "${stageRun.id}" for attempt "${stageRun.attemptId}": ${describeError(error)}`,
      error,
    );
  }
}

async function inspectWorktree(
  options: ImplementStageOptions,
): Promise<GitStatus> {
  try {
    return await options.git.status(options.worktreePath);
  } catch (error) {
    throw new OrchestrationError(
      `failed to inspect the task worktree after the IMPLEMENT invocation for attempt "${options.attemptId}": ${describeError(error)}`,
      error,
    );
  }
}

async function buildImplementContextPack(
  options: ImplementStageOptions,
  now: () => IsoTimestamp,
): Promise<ContextPack> {
  let agentsMarkdown: string;
  try {
    agentsMarkdown = await readFile(
      join(options.worktreePath, "AGENTS.md"),
      "utf8",
    );
  } catch (error) {
    throw new Error(
      `mandatory project rules document "AGENTS.md" is missing or unreadable in the task worktree (${describeError(error)})`,
      { cause: error },
    );
  }
  const guidance = options.guidance;
  const plan = guidance?.plan;
  const reviewFeedback = guidance?.reviewFeedback;
  return buildContextPack({
    task: options.task,
    agentsMarkdown,
    agentsMarkdownPath: "AGENTS.md",
    documents: [
      ...(typeof plan === "string" && plan.trim().length > 0
        ? [
            {
              path: PLAN_CONTEXT_DOCUMENT_PATH,
              content: plan,
            },
          ]
        : []),
      ...(typeof reviewFeedback === "string" &&
      reviewFeedback.trim().length > 0
        ? [
            {
              path: REVIEW_FEEDBACK_CONTEXT_DOCUMENT_PATH,
              content: reviewFeedback,
            },
          ]
        : []),
    ],
    baseRevision: options.baseRevision,
    createdAt: now(),
  });
}

function agentDescriptorOf(agent: AgentRuntime): {
  readonly id: string;
  readonly model?: string | undefined;
} {
  return {
    id: agent.descriptor.id,
    ...(agent.descriptor.model === undefined
      ? {}
      : { model: agent.descriptor.model }),
  };
}

function durationBetween(startedAt: IsoTimestamp, finishedAt: IsoTimestamp): number {
  const duration = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : 0;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultClock(): IsoTimestamp {
  return new Date().toISOString();
}

function validateOptions(options: ImplementStageOptions): void {
  if (options.attemptId.trim().length === 0) {
    throw new OrchestrationError("attemptId must be a non-empty string");
  }
  if (options.worktreePath.trim().length === 0) {
    throw new OrchestrationError("worktreePath must be a non-empty string");
  }
  if (options.baseRevision.trim().length === 0) {
    throw new OrchestrationError("baseRevision must be a non-empty string");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new OrchestrationError("timeoutMs must be a positive finite number");
  }
  if (
    options.cycle !== undefined &&
    (!Number.isInteger(options.cycle) || options.cycle < 1)
  ) {
    throw new OrchestrationError("cycle must be a positive integer");
  }
}
