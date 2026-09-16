/**
 * PLAN stage execution.
 *
 * Executes the `PLAN` stage of a workflow attempt by invoking the selected
 * provider-independent AgentRuntime with the task's ContextPack and a
 * planning-only stage instruction. The agent is asked for an implementation
 * plan, never for source implementation.
 *
 * The stage is provider-independent: there is no OpenCode/Codex branching
 * here and no CLI involvement. The runner owns the stage: the agent result is
 * normalized, the worktree is inspected for source modifications (a PLAN
 * invocation must not change repository contents), and the PLAN StageRun is
 * persisted through the existing StageRun persistence so a later PLAN_REVIEW
 * stage can retrieve the durable plan text.
 *
 * This executor never transitions task state, never verifies, commits, or
 * integrates: timeout, cancellation, process failure, and worktree mutation
 * all produce a failed PLAN-stage outcome; the agent never controls the
 * task's next state.
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
  StageRunStatus,
  StageRunOutput,
  Task,
} from "@agentic-dev-runner/core";
import { buildContextPack } from "@agentic-dev-runner/context";
import type { AgentOutput, AgentRuntime } from "@agentic-dev-runner/agents";
import type { GitManager, GitStatus } from "@agentic-dev-runner/git";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import { OrchestrationError } from "./orchestration-error.js";

const PLAN_STAGE: StageKind = "PLAN";
const REVIEW_FEEDBACK_CONTEXT_DOCUMENT_PATH = "REVIEW_FEEDBACK";

export type PlanStageOutcome =
  | {
      readonly kind: "succeeded";
      readonly attemptId: AttemptId;
      readonly stageRun: StageRun;
      readonly plan: string;
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
 * Optional prior-stage information handed to a fix-cycle PLAN invocation:
 * the actionable feedback of the review that requested this cycle.
 */
export type PlanStageGuidance = {
  readonly reviewFeedback?: string | undefined;
};

export type PlanStageOptions = {
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
  readonly guidance?: PlanStageGuidance | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly now?: (() => IsoTimestamp) | undefined;
};

/**
 * The planning-only stage instruction handed to the agent. It explicitly
 * requests a plan instead of source implementation and forbids worktree
 * changes; adapters render it inside their provider-specific prompt.
 */
export const PLAN_STAGE_INSTRUCTION = [
  "STAGE PLAN — planning only, no implementation.",
  "Produce a step-by-step implementation plan for the task described in the context pack.",
  "Do NOT create, modify, or delete any files. Do NOT run builds, tests, or Git commands.",
  "Do NOT implement source code. Reply with the complete plan as plain text.",
].join(" ");

/**
 * Deterministic PLAN StageRun identity for the attempt. Cycle 1 keeps the
 * original identity; later fix cycles append their cycle number so repeated
 * PLAN invocations never overwrite previous cycle history.
 */
export function planStageRunId(
  attemptId: AttemptId,
  cycle = 1,
): StageRunId {
  return cycle <= 1
    ? `stage_${attemptId}_PLAN`
    : `stage_${attemptId}_PLAN_c${String(cycle)}`;
}

export async function executePlanStage(
  options: PlanStageOptions,
): Promise<PlanStageOutcome> {
  validateOptions(options);
  const now = options.now ?? defaultClock;
  const stageRunId = planStageRunId(options.attemptId, options.cycle);
  const startedAt = now();
  const running: StageRun = {
    id: stageRunId,
    attemptId: options.attemptId,
    stage: PLAN_STAGE,
    status: "RUNNING",
    startedAt,
  };
  try {
    await options.store.putStageRun(running);
  } catch (error) {
    throw new OrchestrationError(
      `failed to persist the RUNNING PLAN stage run "${stageRunId}" for attempt "${options.attemptId}": ${describeError(error)}`,
      error,
    );
  }

  if (options.signal?.aborted === true) {
    return finalize(options, stageRunId, startedAt, {
      status: "CANCELLED",
      failure: { kind: "cancelled", message: "the PLAN stage was cancelled" },
    });
  }

  try {
    return await runPlanStage(options, stageRunId, startedAt, now);
  } catch (error) {
    return finalize(options, stageRunId, startedAt, {
      status: "FAILED",
      failure: {
        kind: "error",
        message: `PLAN stage failed: ${describeError(error)}`,
      },
    });
  }
}

async function runPlanStage(
  options: PlanStageOptions,
  stageRunId: StageRunId,
  startedAt: IsoTimestamp,
  now: () => IsoTimestamp,
): Promise<PlanStageOutcome> {
  const contextPack = await buildPlanContextPack(options, now);
  const agentResult = await options.agent.invoke({
    agent: agentDescriptorOf(options.agent),
    contextPack,
    worktreePath: options.worktreePath,
    timeoutMs: options.timeoutMs,
    instruction: PLAN_STAGE_INSTRUCTION,
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

  const plan = agentResult.output.stdout?.trim() ?? "";
  if (plan.length === 0) {
    return finalizeWithAgentOutput(options, stageRunId, startedAt, {
      status: "FAILED",
      failure: {
        kind: "error",
        message: "the agent produced no plan text",
      },
      output: agentResult.output,
    });
  }

  const mutation = await detectWorktreeMutation(options);
  if (mutation !== undefined) {
    return finalize(options, stageRunId, startedAt, {
      status: "FAILED",
      failure: { kind: "error", message: mutation },
    });
  }

  return finalize(options, stageRunId, startedAt, {
    status: "SUCCEEDED",
    output: { plan },
  });
}

type Finalization = {
  readonly status: StageRunStatus;
  readonly failure?: StageRunFailure | undefined;
  readonly output?: StageRunOutput | undefined;
};

async function finalize(
  options: PlanStageOptions,
  stageRunId: StageRunId,
  startedAt: IsoTimestamp,
  finalization: Finalization,
): Promise<PlanStageOutcome> {
  const finishedAt = (options.now ?? defaultClock)();
  const stageRun: StageRun = {
    id: stageRunId,
    attemptId: options.attemptId,
    stage: PLAN_STAGE,
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
        plan: stageRun.output?.plan ?? "",
        durationMs: durationBetween(startedAt, finishedAt),
      }
    : {
        kind: "failed",
        attemptId: options.attemptId,
        stageRun,
        reason: finalization.failure?.message ?? "PLAN stage failed",
        durationMs: durationBetween(startedAt, finishedAt),
      };
}

/**
 * Failure finalization that preserves the agent's normalized stdout/stderr
 * in the StageRun output so failure information stays durable.
 */
async function finalizeWithAgentOutput(
  options: PlanStageOptions,
  stageRunId: StageRunId,
  startedAt: IsoTimestamp,
  input: {
    readonly status: StageRunStatus;
    readonly failure: StageRunFailure;
    readonly output: AgentOutput;
  },
): Promise<PlanStageOutcome> {
  const stdout = input.output.stdout;
  const stderr = input.output.stderr;
  const hasAgentOutput = stdout !== undefined || stderr !== undefined;
  return finalize(options, stageRunId, startedAt, {
    status: input.status,
    failure: input.failure,
    ...(hasAgentOutput
      ? {
          output: {
            ...(stdout === undefined ? {} : { stdout }),
            ...(stderr === undefined ? {} : { stderr }),
          },
        }
      : {}),
  });
}

async function persistFinalStageRun(
  options: PlanStageOptions,
  stageRun: StageRun,
): Promise<void> {
  try {
    await options.store.putStageRun(stageRun);
  } catch (error) {
    throw new OrchestrationError(
      `failed to persist the ${stageRun.status} PLAN stage run "${stageRun.id}" for attempt "${stageRun.attemptId}": ${describeError(error)}`,
      error,
    );
  }
}

async function buildPlanContextPack(
  options: PlanStageOptions,
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
  return buildContextPack({
    task: options.task,
    agentsMarkdown,
    agentsMarkdownPath: "AGENTS.md",
    documents: planStageGuidanceDocuments(options.guidance),
    baseRevision: options.baseRevision,
    createdAt: now(),
  });
}

/**
 * A fix-cycle PLAN invocation receives the requesting review's actionable
 * feedback as an extra context document; the first cycle has none.
 */
function planStageGuidanceDocuments(
  guidance: PlanStageGuidance | undefined,
): readonly { readonly path: string; readonly content: string }[] {
  const feedback = guidance?.reviewFeedback;
  if (typeof feedback !== "string" || feedback.trim().length === 0) {
    return [];
  }
  return [
    {
      path: REVIEW_FEEDBACK_CONTEXT_DOCUMENT_PATH,
      content: feedback,
    },
  ];
}

/**
 * A PLAN invocation must not change repository contents. Detected through the
 * existing Git change-inspection abstractions: uncommitted changes (including
 * staged and untracked files) and commits created on top of the base revision
 * both fail the stage.
 */
async function detectWorktreeMutation(
  options: PlanStageOptions,
): Promise<string | undefined> {
  let status: GitStatus;
  try {
    status = await options.git.status(options.worktreePath);
  } catch (error) {
    return `failed to inspect the task worktree after the PLAN invocation: ${describeError(error)}`;
  }
  if (!status.clean) {
    const changedPaths = status.entries
      .map((entry) => entry.path)
      .join(", ");
    return `the PLAN invocation modified the task worktree (changed paths: ${changedPaths}); a PLAN stage must produce a plan, not source changes`;
  }
  let headRevision: string;
  try {
    headRevision = await options.git.resolveHeadRevision(options.worktreePath);
  } catch (error) {
    return `failed to resolve the worktree revision after the PLAN invocation: ${describeError(error)}`;
  }
  if (headRevision !== options.baseRevision) {
    return `the PLAN invocation modified the task worktree (worktree revision ${headRevision} no longer matches base revision ${options.baseRevision}); a PLAN stage must produce a plan, not source changes`;
  }
  return undefined;
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

function validateOptions(options: PlanStageOptions): void {
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
