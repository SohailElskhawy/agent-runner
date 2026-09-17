/**
 * Bounded review/fix-loop execution.
 *
 * Orchestrates the two review families the runner currently executes as
 * bounded loops, using the pure M058a cycle policy as the single source of
 * limit truth:
 *
 *   PLAN loop:  PLAN → PLAN_REVIEW            (fix: rerun PLAN with feedback)
 *   CODE loop:  IMPLEMENT → CODE_REVIEW       (fix: rerun IMPLEMENT with feedback)
 *
 * Every loop decision is made by the runner here: the review agents only
 * produce structured decisions; whether another fix/review cycle is
 * permitted is determined exclusively by `evaluateReviewCycle` against the
 * task's configured `maxReviewCycles`. Every PLAN / PLAN_REVIEW / IMPLEMENT
 * / CODE_REVIEW invocation of every cycle is represented by its own durable
 * StageRun (cycle-numbered identities preserve the complete history), the
 * requesting review's actionable feedback is supplied to the next fix
 * invocation through the ContextPack guidance contract, `APPROVED` exits
 * immediately, and budget exhaustion returns an explicit deterministic
 * result for later workflow/task handling.
 *
 * These loops never mutate Task status, never mark a task DONE, never
 * verify, never integrate, and contain no provider-specific behavior: they
 * are orchestration primitives for the later workflow engine.
 */

import type {
  AttemptId,
  IsoTimestamp,
  ReviewDecision,
  StageRun,
  Task,
} from "@agentic-dev-runner/core";
import { evaluateReviewCycle } from "@agentic-dev-runner/core";
import type { AgentRuntime } from "@agentic-dev-runner/agents";
import type { GitManager } from "@agentic-dev-runner/git";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import { OrchestrationError } from "./orchestration-error.js";
import { executePlanStage } from "./plan-stage.js";
import { executePlanReviewStage } from "./plan-review-stage.js";
import { executeImplementStage } from "./implement-stage.js";
import { executeCodeReviewStage } from "./code-review-stage.js";

export type PlanReviewFixLoopOptions = {
  readonly store: RunnerStore;
  readonly git: GitManager;
  readonly agent: AgentRuntime;
  readonly task: Task;
  readonly attemptId: AttemptId;
  readonly worktreePath: string;
  readonly baseRevision: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  readonly now?: (() => IsoTimestamp) | undefined;
};

export type CodeReviewFixLoopOptions = PlanReviewFixLoopOptions & {
  /**
   * Optional guidance handed to every IMPLEMENT invocation of the code
   * loop, typically the approved PLAN output of the same attempt produced
   * by the workflow's plan stages. The plan travels through the existing
   * ContextPack guidance contract; the loop passes the requesting review's
   * feedback alongside it in each cycle.
   */
  readonly initialPlan?: string | undefined;
};

export type PlanReviewFixLoopOutcome =
  | {
      readonly kind: "approved";
      readonly attemptId: AttemptId;
      readonly reviewCycles: number;
      readonly decision: "APPROVED";
      readonly stageRuns: readonly StageRun[];
    }
  | {
      readonly kind: "review-limit-exhausted";
      readonly attemptId: AttemptId;
      readonly reviewCycles: number;
      readonly feedback: string | undefined;
      readonly stageRuns: readonly StageRun[];
    }
  | {
      readonly kind: "failed";
      readonly attemptId: AttemptId;
      readonly reason: string;
      readonly stageRuns: readonly StageRun[];
    };

export type CodeReviewFixLoopOutcome = PlanReviewFixLoopOutcome;

/**
 * Executes a bounded PLAN → PLAN_REVIEW review/fix loop for an existing
 * attempt. Each cycle runs one PLAN invocation and one PLAN_REVIEW
 * invocation; `APPROVED` passes the review gate immediately, a
 * `CHANGES_REQUIRED` review reruns PLAN with its feedback while budget
 * remains, and budget exhaustion returns the explicit
 * `review-limit-exhausted` result.
 */
export async function executePlanReviewFixLoop(
  options: PlanReviewFixLoopOptions,
): Promise<PlanReviewFixLoopOutcome> {
  return runReviewFixLoop(options, {
    runWorkStage: (options, cycle, feedback) =>
      executePlanStage({
        ...options,
        cycle,
        guidance: { reviewFeedback: feedback },
      }),
    runReviewStage: (options, cycle) =>
      executePlanReviewStage({ ...options, cycle }),
  });
}

/**
 * Executes a bounded IMPLEMENT → CODE_REVIEW review/fix loop for an existing
 * attempt. Each cycle runs one IMPLEMENT invocation and one CODE_REVIEW
 * invocation; `APPROVED` passes the review gate immediately, a
 * `CHANGES_REQUIRED` review reruns IMPLEMENT with its feedback while budget
 * remains, and budget exhaustion returns the explicit
 * `review-limit-exhausted` result.
 */
export async function executeCodeReviewFixLoop(
  options: CodeReviewFixLoopOptions,
): Promise<CodeReviewFixLoopOutcome> {
  return runReviewFixLoop(options, {
    runWorkStage: (options, cycle, feedback) =>
      executeImplementStage({
        ...options,
        cycle,
        guidance: {
          ...(typeof options.initialPlan === "string" &&
          options.initialPlan.trim().length > 0
            ? { plan: options.initialPlan }
            : {}),
          ...(feedback === undefined ? {} : { reviewFeedback: feedback }),
        },
      }),
    runReviewStage: (options, cycle) =>
      executeCodeReviewStage({ ...options, cycle }),
  });
}

type ReviewFixLoopOutcome = PlanReviewFixLoopOutcome;

type WorkStageOutcome =
  | { readonly kind: "succeeded"; readonly stageRun: StageRun }
  | {
      readonly kind: "failed";
      readonly stageRun: StageRun;
      readonly reason: string;
    };

type ReviewStageOutcome =
  | {
      readonly kind: "completed";
      readonly stageRun: StageRun;
      readonly decision: ReviewDecision;
      readonly feedback: string | undefined;
    }
  | {
      readonly kind: "failed";
      readonly stageRun: StageRun;
      readonly reason: string;
    };

type ReviewFixLoopStrategy<TOptions extends PlanReviewFixLoopOptions> = {
  runWorkStage: (
    options: TOptions,
    cycle: number,
    feedback: string | undefined,
  ) => Promise<WorkStageOutcome>;
  runReviewStage: (
    options: TOptions,
    cycle: number,
  ) => Promise<ReviewStageOutcome>;
};

async function runReviewFixLoop<TOptions extends PlanReviewFixLoopOptions>(
  options: TOptions,
  strategy: ReviewFixLoopStrategy<TOptions>,
): Promise<ReviewFixLoopOutcome> {
  validateOptions(options);
  const maxReviewCycles = options.task.definition.limits.maxReviewCycles;
  const stageRuns: StageRun[] = [];
  let feedback: string | undefined;

  for (let cycle = 1; cycle <= maxReviewCycles; cycle += 1) {
    const workOutcome = await strategy.runWorkStage(options, cycle, feedback);
    stageRuns.push(workOutcome.stageRun);
    if (workOutcome.kind === "failed") {
      return {
        kind: "failed",
        attemptId: options.attemptId,
        reason: workOutcome.reason ?? "review/fix-loop work stage failed",
        stageRuns,
      };
    }

    const reviewOutcome = await strategy.runReviewStage(options, cycle);
    stageRuns.push(reviewOutcome.stageRun);
    if (reviewOutcome.kind === "failed") {
      return {
        kind: "failed",
        attemptId: options.attemptId,
        reason: reviewOutcome.reason ?? "review/fix-loop review stage failed",
        stageRuns,
      };
    }

    const evaluation = evaluateReviewCycle({
      decision: reviewOutcome.decision,
      completedReviewCycles: cycle,
      maxReviewCycles,
    });
    if (evaluation.accepted === false) {
      throw new OrchestrationError(
        `review/fix loop produced an inconsistent review-cycle state for attempt "${options.attemptId}": ${JSON.stringify(evaluation.rejection)}`,
      );
    }
    if (evaluation.outcome === "PASSED") {
      return {
        kind: "approved",
        attemptId: options.attemptId,
        reviewCycles: cycle,
        decision: "APPROVED",
        stageRuns,
      };
    }
    if (evaluation.outcome === "LIMIT_EXHAUSTED") {
      return {
        kind: "review-limit-exhausted",
        attemptId: options.attemptId,
        reviewCycles: cycle,
        feedback: reviewOutcome.feedback,
        stageRuns,
      };
    }
    feedback = reviewOutcome.feedback;
  }

  return {
    kind: "review-limit-exhausted",
    attemptId: options.attemptId,
    reviewCycles: maxReviewCycles,
    feedback,
    stageRuns,
  };
}

function validateOptions(options: PlanReviewFixLoopOptions): void {
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
  const maxReviewCycles = options.task.definition.limits.maxReviewCycles;
  if (!Number.isInteger(maxReviewCycles) || maxReviewCycles < 1) {
    throw new OrchestrationError(
      `task "${options.task.id}" has an invalid maxReviewCycles limit ${String(maxReviewCycles)}; it must be a positive integer`,
    );
  }
}
