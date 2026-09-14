import type { Attempt, Task } from "@agentic-dev-runner/core";
import type { StoredEvent } from "@agentic-dev-runner/persistence";
import { ORCHESTRATION_EVENTS } from "@agentic-dev-runner/orchestrator";
import type {
  CommitCreatedPayload,
  IntegrationCompletedPayload,
} from "@agentic-dev-runner/orchestrator";
import type {
  LatestAttemptSummary,
  TaskInspection,
  TaskInspectionAttempt,
  TaskInspectionEvent,
} from "./ports.js";

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
  events: readonly StoredEvent[],
): TaskInspectionAttempt {
  const commitEvent = findLatestPayload<CommitCreatedPayload>(
    events,
    ORCHESTRATION_EVENTS.commitCreated,
    attempt.id,
  );
  const integrationEvent = findLatestPayload<IntegrationCompletedPayload>(
    events,
    ORCHESTRATION_EVENTS.integrationCompleted,
    attempt.id,
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

export function buildTaskInspection(input: {
  readonly task: Task;
  readonly attempts: readonly Attempt[];
  readonly events: readonly StoredEvent[];
}): TaskInspection {
  return {
    task: input.task,
    attempts: input.attempts.map((attempt) =>
      toInspectionAttempt(attempt, input.events),
    ),
    events: [...input.events]
      .sort((a, b) => a.sequence - b.sequence)
      .map(toInspectionEvent),
  };
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

function findLatestPayload<T>(
  events: readonly StoredEvent[],
  type: string,
  attemptId: string,
): T | undefined {
  const matching = events.filter(
    (event) => event.type === type && attemptIdOf(event.payload) === attemptId,
  );
  const last = matching.at(-1);
  return last === undefined ? undefined : (last.payload as T);
}
