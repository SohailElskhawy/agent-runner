import type {
  Attempt,
  ExecutionClaim,
  IntegrationQueueEntry,
  StageRun,
  Task,
} from "@agentic-dev-runner/core";
import type { StoredEvent } from "@agentic-dev-runner/persistence";
import { ORCHESTRATION_EVENTS } from "@agentic-dev-runner/orchestrator";
import type {
  CommitCreatedPayload,
  IntegrationCompletedPayload,
  IntegrationVerificationCompletedPayload,
  VerificationCompletedPayload,
} from "@agentic-dev-runner/orchestrator";
import type {
  ExecutionClaimStatusView,
  LatestAttemptSummary,
  TaskInspection,
  TaskInspectionAttempt,
  TaskInspectionEvent,
  TaskInspectionQueueEntry,
  TaskInspectionStage,
  TaskInspectionVerification,
} from "./ports.js";

const RECOVERY_EVENT_PREFIX = "recovery.";

function latestAttemptSummary(attempt: Attempt): LatestAttemptSummary {
  return {
    id: attempt.id,
    number: attempt.number,
    status: attempt.status,
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt ?? null,
    failureMessage: attempt.failure?.message ?? null,
  };
}

function toInspectionAttempt(
  attempt: Attempt,
  stageRuns: readonly StageRun[],
  events: readonly StoredEvent[],
): TaskInspectionAttempt {
  const attemptEvents = events.filter(
    (event) => attemptIdOf(event.payload) === attempt.id,
  );
  const commitEvent = findLatestPayload<CommitCreatedPayload>(
    attemptEvents,
    ORCHESTRATION_EVENTS.commitCreated,
  );
  const integrationEvent = findLatestPayload<IntegrationCompletedPayload>(
    attemptEvents,
    ORCHESTRATION_EVENTS.integrationCompleted,
  );
  const verificationEvent = findLatestPayload<VerificationCompletedPayload>(
    attemptEvents.filter(
      (event) => event.type === ORCHESTRATION_EVENTS.verificationCompleted,
    ),
  );
  const integrationVerificationEvent =
    findLatestPayload<IntegrationVerificationCompletedPayload>(
      attemptEvents.filter(
        (event) =>
          event.type ===
          ORCHESTRATION_EVENTS.integrationVerificationCompleted,
      ),
    );
  return {
    id: attempt.id,
    number: attempt.number,
    status: attempt.status,
    agent: attempt.agent,
    model: attempt.model ?? null,
    baseRevision: attempt.baseRevision,
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt ?? null,
    failure: attempt.failure === undefined
      ? null
      : { kind: attempt.failure.kind, message: attempt.failure.message ?? null },
    commit:
      commitEvent === undefined
        ? null
        : { revision: commitEvent.revision, message: commitEvent.message },
    integration:
      integrationEvent === undefined
        ? null
        : {
            revision: integrationEvent.revision,
            kind: integrationEvent.kind,
          },
    stages: stageRuns.map(toInspectionStage),
    verification:
      verificationEvent === undefined
        ? null
        : toInspectionVerification(verificationEvent),
    integrationVerification:
      integrationVerificationEvent === undefined
        ? null
        : toInspectionVerification(integrationVerificationEvent),
  };
}
function toInspectionStage(stageRun: StageRun): TaskInspectionStage {
  return {
    stage: stageRun.stage,
    status: stageRun.status,
    startedAt: stageRun.startedAt ?? null,
    finishedAt: stageRun.finishedAt ?? null,
    failure: stageRun.failure === undefined
      ? null
      : { kind: stageRun.failure.kind, message: stageRun.failure.message ?? null },
  };
}

function toInspectionVerification(
  payload: {
    readonly status?: VerificationCompletedPayload["status"];
    readonly revision?: string | undefined;
    readonly checks?: readonly {
      readonly kind: string;
      readonly outcome: string;
      readonly failure?: { readonly message?: string } | undefined;
    }[];
  },
): TaskInspectionVerification {
  const checks = Array.isArray(payload.checks) ? payload.checks : [];
  return {
    status: payload.status ?? "UNKNOWN",
    revision: typeof payload.revision === "string" ? payload.revision : null,
    checks: checks.map((check) => ({
      kind: check.kind,
      outcome: check.outcome,
      message: check.failure?.message ?? null,
    })),
  };
}

function toInspectionEvent(event: StoredEvent): TaskInspectionEvent {
  return {
    sequence: event.sequence,
    type: event.type,
    occurredAt: event.occurredAt,
    payload: event.payload,
  };
}

function toClaimStatusView(claim: ExecutionClaim): ExecutionClaimStatusView {
  return {
    executionId: claim.id,
    taskId: claim.taskId,
    status: claim.status,
    claimedAt: claim.claimedAt,
    renewedAt: claim.renewedAt,
    leaseExpiresAt: claim.leaseExpiresAt,
  };
}

function toQueueEntryView(
  entry: IntegrationQueueEntry,
): TaskInspectionQueueEntry {
  return {
    id: entry.id,
    sequence: entry.sequence,
    status: entry.status,
    taskRevision: entry.taskRevision,
    branch: entry.branch,
    enqueuedAt: entry.enqueuedAt,
    finishedAt: entry.finishedAt ?? null,
    failureMessage: entry.failure?.message ?? null,
  };
}

export function buildTaskInspection(input: {
  readonly task: Task;
  readonly attempts: readonly Attempt[];
  readonly stageRuns: readonly StageRun[];
  readonly events: readonly StoredEvent[];
  readonly claims: readonly ExecutionClaim[];
  readonly integrationQueue: readonly IntegrationQueueEntry[];
}): TaskInspection {
  const orderedEvents = [...input.events].sort(
    (a, b) => a.sequence - b.sequence,
  );
  const recoveryEvents = orderedEvents.filter((event) =>
    event.type.startsWith(RECOVERY_EVENT_PREFIX),
  );
  return {
    task: input.task,
    attempts: input.attempts.map((attempt) => {
      const attemptStageRuns = input.stageRuns
        .filter((stageRun) => stageRun.attemptId === attempt.id)
        .sort((a, b) => a.stage.localeCompare(b.stage));
      return toInspectionAttempt(attempt, attemptStageRuns, orderedEvents);
    }),
    events: orderedEvents.map(toInspectionEvent),
    claims: [...input.claims]
      .sort((a, b) => (a.claimedAt < b.claimedAt ? -1 : 1))
      .map(toClaimStatusView),
    integrationQueue: [...input.integrationQueue]
      .sort((a, b) => a.sequence - b.sequence)
      .map(toQueueEntryView),
    recoveryEvents: recoveryEvents.map(toInspectionEvent),
    failureReason: failureReasonOf(input.attempts, orderedEvents),
  };
}

function failureReasonOf(
  attempts: readonly Attempt[],
  events: readonly StoredEvent[],
): string | null {
  for (const attempt of [...attempts].reverse()) {
    const message = attempt.failure?.message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  for (const event of [...events].reverse()) {
    if (event.type !== ORCHESTRATION_EVENTS.taskTransitioned) {
      continue;
    }
    const payload = event.payload as Partial<{ failure: { message?: string } }>;
    const message = payload.failure?.message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  return null;
}

export function toLatestAttemptSummary(
  attempt: Attempt | undefined,
): LatestAttemptSummary | null {
  return attempt === undefined ? null : latestAttemptSummary(attempt);
}

function attemptIdOf(payload: unknown): string | undefined {
  if (typeof payload === "object" && payload !== null && "attemptId" in payload) {
    const value = (payload as { attemptId?: unknown }).attemptId;
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function findLatestPayload<T extends object>(
  events: readonly StoredEvent[],
  type?: string,
): T | undefined {
  const matching = events.filter(
    (event) => type === undefined || event.type === type,
  );
  const last = matching.at(-1);
  return last === undefined ? undefined : (last.payload as T);
}
