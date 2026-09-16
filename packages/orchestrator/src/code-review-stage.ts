/**
 * CODE_REVIEW stage execution.
 *
 * Executes the `CODE_REVIEW` stage of a workflow attempt by having the
 * selected provider-independent AgentRuntime evaluate the actual
 * implementation delta of that attempt. The reviewer is handed the real
 * Git change evidence (the unified diff of the task worktree against the
 * attempt's base revision, plus the contents of untracked new files) and,
 * when one was persisted by the PLAN stage of the same attempt, the durable
 * plan. The reviewer is an untrusted worker: it receives an explicit
 * review-only instruction and must never fix, implement, commit, or
 * integrate anything.
 *
 * The stage is provider-independent: the selected AgentRuntime is invoked
 * through the existing runtime contract, and there is no OpenCode/Codex
 * branching and no CLI involvement. The agent must answer with a structured
 * review result (decision `APPROVED` or `CHANGES_REQUIRED`, plus actionable
 * feedback when changes are required). Malformed review output, agent
 * failures, timeouts, cancellations, and worktree mutations caused during
 * the review all produce a failed CODE_REVIEW-stage outcome.
 *
 * This executor never transitions task state, never decides the next
 * workflow stage, never runs verification, and never fixes or integrates:
 * the runner owns authoritative workflow state, so a completed review is
 * persisted as a terminal StageRun whose structured result later stages and
 * the workflow engine can consume. It is a stage execution primitive only.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AttemptId,
  ContextPack,
  IsoTimestamp,
  ReviewDecision,
  ReviewResult,
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
import type {
  GitManager,
  GitStatus,
  GitStatusEntry,
} from "@agentic-dev-runner/git";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import { OrchestrationError } from "./orchestration-error.js";
import { parseStructuredReview } from "./review-output.js";

const CODE_REVIEW_STAGE: StageKind = "CODE_REVIEW";
const PLAN_STAGE: StageKind = "PLAN";
const PLAN_CONTEXT_DOCUMENT_PATH = "PLAN";
const IMPLEMENTATION_DIFF_DOCUMENT_PATH = "IMPLEMENTATION_DIFF";

export type CodeReviewStageOutcome =
  | {
      readonly kind: "completed";
      readonly attemptId: AttemptId;
      readonly stageRun: StageRun;
      readonly decision: ReviewDecision;
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

export type CodeReviewStageOptions = {
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
 * restricts the agent to evaluating the implementation evidence provided in
 * the context pack and forbids any repository or Git work; adapters render
 * it inside their provider-specific prompt.
 */
export const CODE_REVIEW_STAGE_INSTRUCTION = [
  "STAGE CODE_REVIEW — review only, no implementation.",
  "Evaluate the implementation changes provided in the context pack against",
  "the task objective, acceptance criteria, scope, project rules (AGENTS.md),",
  "and architecture guidance, and against the plan when one is provided.",
  "Identify correctness, scope, architecture, safety, and verification",
  "concerns in the implementation.",
  "Do NOT fix issues. Do NOT implement source code. Do NOT create, modify,",
  "or delete any files. Do NOT run builds, tests, or Git commands. Do NOT",
  "create commits or perform Git integration.",
  'Reply with a single JSON object and nothing else: {"decision":"APPROVED"}',
  'when the implementation is acceptable, or {"decision":"CHANGES_REQUIRED",',
  '"feedback":"<actionable feedback describing the required changes>"} when',
  "changes are required.",
].join(" ");

/**
 * Deterministic CODE_REVIEW StageRun identity for the attempt. Cycle 1 keeps
 * the original identity; later fix cycles append their cycle number so
 * repeated CODE_REVIEW invocations never overwrite previous cycle history.
 */
export function codeReviewStageRunId(
  attemptId: AttemptId,
  cycle = 1,
): StageRunId {
  return cycle <= 1
    ? `stage_${attemptId}_CODE_REVIEW`
    : `stage_${attemptId}_CODE_REVIEW_c${String(cycle)}`;
}

export async function executeCodeReviewStage(
  options: CodeReviewStageOptions,
): Promise<CodeReviewStageOutcome> {
  validateOptions(options);
  const now = options.now ?? defaultClock;
  const stageRunId = codeReviewStageRunId(options.attemptId, options.cycle);
  const startedAt = now();
  const running: StageRun = {
    id: stageRunId,
    attemptId: options.attemptId,
    stage: CODE_REVIEW_STAGE,
    status: "RUNNING",
    startedAt,
  };
  try {
    await options.store.putStageRun(running);
  } catch (error) {
    throw new OrchestrationError(
      `failed to persist the RUNNING CODE_REVIEW stage run "${stageRunId}" for attempt "${options.attemptId}": ${describeError(error)}`,
      error,
    );
  }

  if (options.signal?.aborted === true) {
    return finalize(options, stageRunId, startedAt, {
      status: "CANCELLED",
      failure: {
        kind: "cancelled",
        message: "the CODE_REVIEW stage was cancelled",
      },
    });
  }

  try {
    return await runCodeReviewStage(options, stageRunId, startedAt, now);
  } catch (error) {
    return finalize(options, stageRunId, startedAt, {
      status: "FAILED",
      failure: {
        kind: "error",
        message: `CODE_REVIEW stage failed: ${describeError(error)}`,
      },
    });
  }
}

async function runCodeReviewStage(
  options: CodeReviewStageOptions,
  stageRunId: StageRunId,
  startedAt: IsoTimestamp,
  now: () => IsoTimestamp,
): Promise<CodeReviewStageOutcome> {
  const baseline = await captureWorktreeBaseline(options);
  const evidence = await loadImplementationEvidence(options, baseline.status);
  if (evidence.length === 0) {
    return finalize(options, stageRunId, startedAt, {
      status: "FAILED",
      failure: {
        kind: "error",
        message: `attempt "${options.attemptId}" has no implementation changes to review against base revision ${options.baseRevision}; run the IMPLEMENT stage first`,
      },
    });
  }

  const contextPack = await buildCodeReviewContextPack(
    options,
    evidence,
    baseline.plan,
    now,
  );
  const agentResult = await options.agent.invoke({
    agent: agentDescriptorOf(options.agent),
    contextPack,
    worktreePath: options.worktreePath,
    timeoutMs: options.timeoutMs,
    instruction: CODE_REVIEW_STAGE_INSTRUCTION,
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

  const review = parseStructuredReview(agentResult.output, CODE_REVIEW_STAGE);
  if (typeof review === "string") {
    return finalizeWithAgentOutput(options, stageRunId, startedAt, {
      status: "FAILED",
      failure: { kind: "error", message: review },
      output: agentResult.output,
    });
  }

  const mutation = await detectWorktreeMutation(options, baseline);
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
  options: CodeReviewStageOptions,
  stageRunId: StageRunId,
  startedAt: IsoTimestamp,
  finalization: Finalization,
): Promise<CodeReviewStageOutcome> {
  const finishedAt = (options.now ?? defaultClock)();
  const stageRun: StageRun = {
    id: stageRunId,
    attemptId: options.attemptId,
    stage: CODE_REVIEW_STAGE,
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
    reason: finalization.failure?.message ?? "CODE_REVIEW stage failed",
    durationMs: durationBetween(startedAt, finishedAt),
  };
}

/**
 * Success finalization for a completed review: the structured review result
 * plus the reviewer's raw stdout are both persisted as durable stage output
 * for later workflow-engine decisions.
 */
async function finalizeCompleted(
  options: CodeReviewStageOptions,
  stageRunId: StageRunId,
  startedAt: IsoTimestamp,
  review: ReviewResult,
  rawOutput: string | undefined,
): Promise<CodeReviewStageOutcome> {
  const finishedAt = (options.now ?? defaultClock)();
  const stageRun: StageRun = {
    id: stageRunId,
    attemptId: options.attemptId,
    stage: CODE_REVIEW_STAGE,
    status: "SUCCEEDED",
    startedAt,
    finishedAt,
    output: {
      codeReview: review,
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
  options: CodeReviewStageOptions,
  stageRunId: StageRunId,
  startedAt: IsoTimestamp,
  input: {
    readonly status: StageRunStatus;
    readonly failure: StageRunFailure;
    readonly output: AgentOutput;
  },
): Promise<CodeReviewStageOutcome> {
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
  options: CodeReviewStageOptions,
  stageRun: StageRun,
): Promise<void> {
  try {
    await options.store.putStageRun(stageRun);
  } catch (error) {
    throw new OrchestrationError(
      `failed to persist the ${stageRun.status} CODE_REVIEW stage run "${stageRun.id}" for attempt "${stageRun.attemptId}": ${describeError(error)}`,
      error,
    );
  }
}

/**
 * Pre-invocation worktree snapshot. It supplies the implementation evidence
 * (tracked delta plus untracked files) and the mutation baseline the review
 * is later compared against: unlike the plan stages, a CODE_REVIEW worktree
 * legitimately contains the attempt's implementation changes and may have
 * commits on top of the base revision, so mutation detection cannot assume a
 * clean worktree at the base revision. Untracked files are recorded with a
 * content digest because a modified untracked file keeps the same `??`
 * porcelain entry and would otherwise escape mutation detection.
 */
type WorktreeBaseline = {
  readonly status: GitStatus;
  readonly headRevision: string;
  readonly untrackedFiles: readonly UntrackedFileIdentity[];
  readonly plan: string | undefined;
};

/**
 * Content identity of one untracked worktree file. The digest is computed
 * over the raw bytes (no line-ending or encoding normalization); `undefined`
 * means the content could not be read when the baseline was captured.
 */
type UntrackedFileIdentity = {
  readonly path: string;
  readonly digest: string | undefined;
};

async function captureWorktreeBaseline(
  options: CodeReviewStageOptions,
): Promise<WorktreeBaseline> {
  let status: GitStatus;
  try {
    status = await options.git.status(options.worktreePath);
  } catch (error) {
    throw new OrchestrationError(
      `failed to inspect the task worktree before the CODE_REVIEW stage for attempt "${options.attemptId}": ${describeError(error)}`,
      error,
    );
  }
  let headRevision: string;
  try {
    headRevision = await options.git.resolveHeadRevision(options.worktreePath);
  } catch (error) {
    throw new OrchestrationError(
      `failed to resolve the task worktree revision before the CODE_REVIEW stage for attempt "${options.attemptId}": ${describeError(error)}`,
      error,
    );
  }
  return {
    status,
    headRevision,
    untrackedFiles: await captureUntrackedIdentities(options, status.entries),
    plan: await loadPersistedPlan(options),
  };
}

async function captureUntrackedIdentities(
  options: CodeReviewStageOptions,
  entries: readonly GitStatusEntry[],
): Promise<UntrackedFileIdentity[]> {
  const identities: UntrackedFileIdentity[] = [];
  for (const entry of entries) {
    if (!isUntracked(entry)) {
      continue;
    }
    identities.push({
      path: entry.path,
      digest: await digestUntrackedFile(options, entry.path),
    });
  }
  return identities;
}

async function digestUntrackedFile(
  options: CodeReviewStageOptions,
  path: string,
): Promise<string | undefined> {
  try {
    const content = await readFile(join(options.worktreePath, path));
    return `sha256:${createHash("sha256").update(content).digest("hex")}`;
  } catch {
    return undefined;
  }
}

/**
 * The PLAN output is the durable one persisted by the most recent SUCCEEDED
 * PLAN stage of the same attempt (the latest fix-cycle plan when earlier
 * cycles exist). A CODE_REVIEW stage may run without a plan (workflows where
 * the review follows implementation directly), so a missing plan is not an
 * error: the review then evaluates the implementation evidence only.
 */
async function loadPersistedPlan(
  options: CodeReviewStageOptions,
): Promise<string | undefined> {
  let stageRuns: StageRun[];
  try {
    stageRuns = await options.store.listStageRuns(options.attemptId);
  } catch (error) {
    throw new OrchestrationError(
      `failed to load the persisted PLAN stage run for attempt "${options.attemptId}": ${describeError(error)}`,
      error,
    );
  }
  let latest: string | undefined;
  for (const stageRun of stageRuns) {
    if (stageRun.stage !== PLAN_STAGE || stageRun.status !== "SUCCEEDED") {
      continue;
    }
    const plan = stageRun.output?.plan;
    if (typeof plan === "string" && plan.trim().length > 0) {
      latest = plan;
    }
  }
  return latest;
}

/**
 * Deterministic implementation evidence for the attempt: the real unified
 * diff of the task worktree against the attempt's base revision (covering
 * committed, staged, and unstaged tracked changes) plus the full contents of
 * untracked new files. The reviewer evaluates this evidence, never an
 * agent-written change summary.
 */
async function loadImplementationEvidence(
  options: CodeReviewStageOptions,
  status: GitStatus,
): Promise<string> {
  let diff: string;
  try {
    diff = await options.git.getDiffAgainstRevision(
      options.worktreePath,
      options.baseRevision,
    );
  } catch (error) {
    throw new OrchestrationError(
      `failed to load the implementation diff for attempt "${options.attemptId}" against base revision ${options.baseRevision}: ${describeError(error)}`,
      error,
    );
  }
  const untrackedFiles = status.entries.filter((entry) => isUntracked(entry));
  const sections: string[] = [];
  if (diff.trim().length > 0) {
    sections.push(diff.trimEnd());
  }
  for (const entry of untrackedFiles) {
    sections.push(
      `NEW UNTRACKED FILE: ${entry.path}\n${await readUntrackedFileContent(options, entry.path)}`,
    );
  }
  return sections.join("\n\n");
}

function isUntracked(entry: GitStatusEntry): boolean {
  return entry.indexStatus === "?" && entry.worktreeStatus === "?";
}

async function readUntrackedFileContent(
  options: CodeReviewStageOptions,
  path: string,
): Promise<string> {
  try {
    return await readFile(join(options.worktreePath, path), "utf8");
  } catch (error) {
    return `(content unavailable: ${describeError(error)})`;
  }
}

async function buildCodeReviewContextPack(
  options: CodeReviewStageOptions,
  evidence: string,
  plan: string | undefined,
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
        path: IMPLEMENTATION_DIFF_DOCUMENT_PATH,
        content: evidence,
      },
      ...(plan === undefined
        ? []
        : [
            {
              path: PLAN_CONTEXT_DOCUMENT_PATH,
              content: plan,
            },
          ]),
    ],
    baseRevision: options.baseRevision,
    createdAt: now(),
  });
}

/**
 * A CODE_REVIEW invocation must not change repository contents. Detected by
 * comparing the worktree state after the invocation with the pre-invocation
 * baseline: any newly uncommitted change (including staged and untracked
 * files), any commit created during the review, or any change to the
 * pre-existing untracked files' content digests fails the stage.
 */
async function detectWorktreeMutation(
  options: CodeReviewStageOptions,
  baseline: WorktreeBaseline,
): Promise<string | undefined> {
  let status: GitStatus;
  try {
    status = await options.git.status(options.worktreePath);
  } catch (error) {
    return `failed to inspect the task worktree after the CODE_REVIEW invocation: ${describeError(error)}`;
  }
  if (!statusesEqual(baseline.status, status)) {
    const changedPaths = status.entries.map((entry) => entry.path).join(", ");
    return `the CODE_REVIEW invocation modified the task worktree (changed paths: ${changedPaths}); a review stage must not modify repository files`;
  }
  let headRevision: string;
  try {
    headRevision = await options.git.resolveHeadRevision(options.worktreePath);
  } catch (error) {
    return `failed to resolve the worktree revision after the CODE_REVIEW invocation: ${describeError(error)}`;
  }
  if (headRevision !== baseline.headRevision) {
    return `the CODE_REVIEW invocation modified the task worktree (worktree revision ${headRevision} no longer matches pre-review revision ${baseline.headRevision}); a review stage must not modify repository files`;
  }
  const untrackedMutation = untrackedIdentityMutationMessage(
    baseline.untrackedFiles,
    await captureUntrackedIdentities(options, status.entries),
  );
  if (untrackedMutation !== undefined) {
    return untrackedMutation;
  }
  return undefined;
}

/**
 * Compares the untracked file identities after the review against the
 * pre-invocation baseline. Path-set changes and digest changes both count as
 * reviewer mutation; byte-identical files (including files that were
 * unreadable both times) are unchanged.
 */
function untrackedIdentityMutationMessage(
  baseline: readonly UntrackedFileIdentity[],
  current: readonly UntrackedFileIdentity[],
): string | undefined {
  const baselineByPath = new Map(
    baseline.map((entry) => [entry.path, entry] as const),
  );
  const currentByPath = new Map(
    current.map((entry) => [entry.path, entry] as const),
  );
  for (const entry of current) {
    const before = baselineByPath.get(entry.path);
    if (before === undefined) {
      return untrackedMutationMessage(`new untracked file appeared: ${entry.path}`);
    }
    if (before.digest !== entry.digest) {
      return untrackedMutationMessage(
        `untracked file content changed: ${entry.path}`,
      );
    }
  }
  for (const entry of baseline) {
    if (!currentByPath.has(entry.path)) {
      return untrackedMutationMessage(`untracked file removed: ${entry.path}`);
    }
  }
  return undefined;
}

function untrackedMutationMessage(detail: string): string {
  return `the CODE_REVIEW invocation modified the task worktree (${detail}); a review stage must not modify repository files`;
}

function statusesEqual(before: GitStatus, after: GitStatus): boolean {
  return serializeStatus(before) === serializeStatus(after);
}

function serializeStatus(status: GitStatus): string {
  return [...status.entries]
    .map((entry) =>
      [
        entry.indexStatus,
        entry.worktreeStatus,
        entry.path,
        entry.previousPath ?? "",
      ].join("\u0000"),
    )
    .sort()
    .join("\u0001");
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

function validateOptions(options: CodeReviewStageOptions): void {
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
