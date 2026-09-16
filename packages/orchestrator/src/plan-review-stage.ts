/**
 * PLAN_REVIEW stage execution.
 *
 * Executes the `PLAN_REVIEW` stage of a workflow attempt by reviewing the
 * durable PLAN output persisted by the PLAN stage of the same attempt. The
 * reviewer agent is handed the persisted plan inside a fresh ContextPack and
 * an explicit review-only instruction; it is never asked to create a plan or
 * implement anything.
 *
 * The stage is provider-independent: the selected AgentRuntime is invoked
 * through the existing runtime contract, and there is no OpenCode/Codex
 * branching and no CLI involvement. The agent must answer with a structured
 * review result (decision `APPROVED` or `CHANGES_REQUIRED`, plus actionable
 * feedback when changes are required). Malformed review output, agent
 * failures, timeouts, cancellations, and worktree mutations all produce a
 * failed PLAN_REVIEW-stage outcome.
 *
 * This executor never transitions task state, never decides the next
 * workflow stage, and never verifies, commits, or integrates: the runner
 * owns authoritative workflow state, so a completed review is persisted as a
 * terminal StageRun whose structured result later stages and the workflow
 * engine can consume. It is a stage execution primitive only.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AttemptId,
  ContextPack,
  IsoTimestamp,
  PlanReviewDecision,
  PlanReviewResult,
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
import type { GitManager, GitStatus } from "@agentic-dev-runner/git";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import { OrchestrationError } from "./orchestration-error.js";
import { planStageRunId } from "./plan-stage.js";
import { parseStructuredReview } from "./review-output.js";

const PLAN_REVIEW_STAGE: StageKind = "PLAN_REVIEW";
const PLAN_STAGE: StageKind = "PLAN";
const PLAN_CONTEXT_DOCUMENT_PATH = "PLAN";

export type PlanReviewStageOutcome =
  | {
      readonly kind: "completed";
      readonly attemptId: AttemptId;
      readonly stageRun: StageRun;
      readonly decision: PlanReviewDecision;
      readonly feedback: string | undefined;
      readonly durationMs: number;
    }
  | {
      readonly kind: "failed";
      readonly attemptId: AttemptId;
      readonly stageRun: StageRun;
      readonly reason: string;
      readonly durationMs: number;
    };

export type PlanReviewStageOptions = {
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
  readonly signal?: AbortSignal | undefined;
  readonly now?: (() => IsoTimestamp) | undefined;
};

/**
 * The review-only stage instruction handed to the agent. It explicitly
 * restricts the agent to evaluating the persisted plan provided in the
 * context pack and forbids any repository work; adapters render it inside
 * their provider-specific prompt.
 */
export const PLAN_REVIEW_STAGE_INSTRUCTION = [
  "STAGE PLAN_REVIEW — review only, no implementation.",
  "Evaluate the implementation plan provided in the context pack against the",
  "task objective, acceptance criteria, scope, project rules (AGENTS.md), and",
  "architecture guidance.",
  "Do NOT implement source code. Do NOT create, modify, or delete any files.",
  "Do NOT run builds, tests, or Git commands.",
  'Reply with a single JSON object and nothing else: {"decision":"APPROVED"}',
  'when the plan is acceptable, or {"decision":"CHANGES_REQUIRED",',
  '"feedback":"<actionable feedback describing the required changes>"} when',
  "the plan must be revised.",
].join(" ");

/**
 * Deterministic PLAN_REVIEW StageRun identity for the attempt. Cycle 1 keeps
 * the original identity; later fix cycles append their cycle number so
 * repeated PLAN_REVIEW invocations never overwrite previous cycle history.
 */
export function planReviewStageRunId(
  attemptId: AttemptId,
  cycle = 1,
): StageRunId {
  return cycle <= 1
    ? `stage_${attemptId}_PLAN_REVIEW`
    : `stage_${attemptId}_PLAN_REVIEW_c${String(cycle)}`;
}

export async function executePlanReviewStage(
  options: PlanReviewStageOptions,
): Promise<PlanReviewStageOutcome> {
  validateOptions(options);
  const now = options.now ?? defaultClock;
  const stageRunId = planReviewStageRunId(options.attemptId, options.cycle);
  const startedAt = now();
  const running: StageRun = {
    id: stageRunId,
    attemptId: options.attemptId,
    stage: PLAN_REVIEW_STAGE,
    status: "RUNNING",
    startedAt,
  };
  try {
    await options.store.putStageRun(running);
  } catch (error) {
    throw new OrchestrationError(
      `failed to persist the RUNNING PLAN_REVIEW stage run "${stageRunId}" for attempt "${options.attemptId}": ${describeError(error)}`,
      error,
    );
  }

  if (options.signal?.aborted === true) {
    return finalize(options, stageRunId, startedAt, {
      status: "CANCELLED",
      failure: {
        kind: "cancelled",
        message: "the PLAN_REVIEW stage was cancelled",
      },
    });
  }

  try {
    return await runPlanReviewStage(options, stageRunId, startedAt, now);
  } catch (error) {
    return finalize(options, stageRunId, startedAt, {
      status: "FAILED",
      failure: {
        kind: "error",
        message: `PLAN_REVIEW stage failed: ${describeError(error)}`,
      },
    });
  }
}

async function runPlanReviewStage(
  options: PlanReviewStageOptions,
  stageRunId: StageRunId,
  startedAt: IsoTimestamp,
  now: () => IsoTimestamp,
): Promise<PlanReviewStageOutcome> {
  const planResolution = await loadReviewedPlan(options);
  if (planResolution.kind === "missing") {
    return finalize(options, stageRunId, startedAt, {
      status: "FAILED",
      failure: {
        kind: "error",
        message: planResolution.reason,
      },
    });
  }

  const contextPack = await buildPlanReviewContextPack(
    options,
    planResolution.plan,
    now,
  );
  const agentResult = await options.agent.invoke({
    agent: agentDescriptorOf(options.agent),
    contextPack,
    worktreePath: options.worktreePath,
    timeoutMs: options.timeoutMs,
    instruction: PLAN_REVIEW_STAGE_INSTRUCTION,
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

  const review = parseStructuredReview(agentResult.output, PLAN_REVIEW_STAGE);
  if (typeof review === "string") {
    return finalizeWithAgentOutput(options, stageRunId, startedAt, {
      status: "FAILED",
      failure: { kind: "error", message: review },
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

  return finalizeCompleted(
    options,
    stageRunId,
    startedAt,
    review,
    agentResult.output.stdout,
  );
}

type Finalization = {
  readonly status: StageRunStatus;
  readonly failure?: StageRunFailure | undefined;
  readonly output?: StageRunOutput | undefined;
};

async function finalize(
  options: PlanReviewStageOptions,
  stageRunId: StageRunId,
  startedAt: IsoTimestamp,
  finalization: Finalization,
): Promise<PlanReviewStageOutcome> {
  const finishedAt = (options.now ?? defaultClock)();
  const stageRun: StageRun = {
    id: stageRunId,
    attemptId: options.attemptId,
    stage: PLAN_REVIEW_STAGE,
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
  return {
    kind: "failed",
    attemptId: options.attemptId,
    stageRun,
    reason: finalization.failure?.message ?? "PLAN_REVIEW stage failed",
    durationMs: durationBetween(startedAt, finishedAt),
  };
}

/**
 * Success finalization for a completed review: the structured review result
 * plus the reviewer's raw stdout are both persisted as durable stage output
 * for later workflow-engine decisions.
 */
async function finalizeCompleted(
  options: PlanReviewStageOptions,
  stageRunId: StageRunId,
  startedAt: IsoTimestamp,
  review: PlanReviewResult,
  rawOutput: string | undefined,
): Promise<PlanReviewStageOutcome> {
  const finishedAt = (options.now ?? defaultClock)();
  const stageRun: StageRun = {
    id: stageRunId,
    attemptId: options.attemptId,
    stage: PLAN_REVIEW_STAGE,
    status: "SUCCEEDED",
    startedAt,
    finishedAt,
    output: {
      planReview: review,
      ...(rawOutput === undefined ? {} : { stdout: rawOutput }),
    },
  };
  await persistFinalStageRun(options, stageRun);
  return {
    kind: "completed",
    attemptId: options.attemptId,
    stageRun,
    decision: review.decision,
    feedback: review.feedback,
    durationMs: durationBetween(startedAt, finishedAt),
  };
}

/**
 * Failure finalization that preserves the agent's normalized stdout/stderr
 * in the StageRun output so failure information stays durable.
 */
async function finalizeWithAgentOutput(
  options: PlanReviewStageOptions,
  stageRunId: StageRunId,
  startedAt: IsoTimestamp,
  input: {
    readonly status: StageRunStatus;
    readonly failure: StageRunFailure;
    readonly output: AgentOutput;
  },
): Promise<PlanReviewStageOutcome> {
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
  options: PlanReviewStageOptions,
  stageRun: StageRun,
): Promise<void> {
  try {
    await options.store.putStageRun(stageRun);
  } catch (error) {
    throw new OrchestrationError(
      `failed to persist the ${stageRun.status} PLAN_REVIEW stage run "${stageRun.id}" for attempt "${stageRun.attemptId}": ${describeError(error)}`,
      error,
    );
  }
}

/**
 * Resolution of the PLAN output a PLAN_REVIEW invocation reviews.
 */
type ReviewedPlanResolution =
  | { readonly kind: "resolved"; readonly plan: string }
  | { readonly kind: "missing"; readonly reason: string };

/**
 * The PLAN output under review is determined by workflow cycle identity, not
 * by persistence row ordering. An invocation with an explicit review cycle
 * (bounded review/fix loops) pairs with the exact deterministic PLAN StageRun
 * of its own cycle (`planStageRunId(attemptId, cycle)`); a missing,
 * unsuccessful, or output-less partner run fails the stage explicitly. A
 * standalone invocation without a cycle keeps the previous behavior: it
 * reviews the last successful PLAN of the attempt in `listStageRuns` order,
 * so non-loop callers are unaffected. The reviewer never re-creates a plan.
 */
async function loadReviewedPlan(
  options: PlanReviewStageOptions,
): Promise<ReviewedPlanResolution> {
  let stageRuns: StageRun[];
  try {
    stageRuns = await options.store.listStageRuns(options.attemptId);
  } catch (error) {
    throw new OrchestrationError(
      `failed to load the persisted PLAN stage run for attempt "${options.attemptId}": ${describeError(error)}`,
      error,
    );
  }
  if (options.cycle !== undefined) {
    const partnerId = planStageRunId(options.attemptId, options.cycle);
    const partner = stageRuns.find((stageRun) => stageRun.id === partnerId);
    const plan = partner === undefined ? undefined : succeededPlanOutputOf(partner);
    if (plan === undefined) {
      return {
        kind: "missing",
        reason: `attempt "${options.attemptId}" has no succeeded PLAN stage run "${partnerId}" with usable plan output for review cycle ${String(options.cycle)}; run the PLAN stage of this review cycle first`,
      };
    }
    return { kind: "resolved", plan };
  }
  let latest: string | undefined;
  for (const stageRun of stageRuns) {
    const plan = succeededPlanOutputOf(stageRun);
    if (plan !== undefined) {
      latest = plan;
    }
  }
  if (latest === undefined) {
    return {
      kind: "missing",
      reason: `attempt "${options.attemptId}" has no persisted PLAN output to review; run the PLAN stage first`,
    };
  }
  return { kind: "resolved", plan: latest };
}

/**
 * The durable PLAN output of a StageRun, defined only for SUCCEEDED PLAN
 * stage runs with non-empty persisted plan text.
 */
function succeededPlanOutputOf(stageRun: StageRun): string | undefined {
  if (stageRun.stage !== PLAN_STAGE || stageRun.status !== "SUCCEEDED") {
    return undefined;
  }
  const plan = stageRun.output?.plan;
  return typeof plan === "string" && plan.trim().length > 0 ? plan : undefined;
}

async function buildPlanReviewContextPack(
  options: PlanReviewStageOptions,
  plan: string,
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
    documents: [
      {
        path: PLAN_CONTEXT_DOCUMENT_PATH,
        content: plan,
      },
    ],
    baseRevision: options.baseRevision,
    createdAt: now(),
  });
}

/**
 * A PLAN_REVIEW invocation must not change repository contents. Detected
 * through the existing Git change-inspection abstractions: uncommitted
 * changes (including staged and untracked files) and commits created on top
 * of the base revision both fail the stage.
 */
async function detectWorktreeMutation(
  options: PlanReviewStageOptions,
): Promise<string | undefined> {
  let status: GitStatus;
  try {
    status = await options.git.status(options.worktreePath);
  } catch (error) {
    return `failed to inspect the task worktree after the PLAN_REVIEW invocation: ${describeError(error)}`;
  }
  if (!status.clean) {
    const changedPaths = status.entries
      .map((entry) => entry.path)
      .join(", ");
    return `the PLAN_REVIEW invocation modified the task worktree (changed paths: ${changedPaths}); a review stage must not modify repository files`;
  }
  let headRevision: string;
  try {
    headRevision = await options.git.resolveHeadRevision(options.worktreePath);
  } catch (error) {
    return `failed to resolve the worktree revision after the PLAN_REVIEW invocation: ${describeError(error)}`;
  }
  if (headRevision !== options.baseRevision) {
    return `the PLAN_REVIEW invocation modified the task worktree (worktree revision ${headRevision} no longer matches base revision ${options.baseRevision}); a review stage must not modify repository files`;
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

function validateOptions(options: PlanReviewStageOptions): void {
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
