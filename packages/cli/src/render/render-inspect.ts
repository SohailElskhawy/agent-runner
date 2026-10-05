import type { CliIo } from "../io.js";
import type {
  TaskInspection,
  TaskInspectionEvent,
  TaskInspectionStage,
  TaskInspectionVerification,
} from "../application/ports.js";

export function renderTaskInspection(
  io: CliIo,
  inspection: TaskInspection,
): void {
  const task = inspection.task;
  io.writeLine(`task: ${task.id}`);
  io.writeLine(`  title: ${task.title}`);
  io.writeLine(`  project: ${task.projectId}`);
  io.writeLine(`  milestone: ${task.milestone}`);
  io.writeLine(`  status: ${task.status}`);
  io.writeLine(`  workflow: ${task.workflow}`);
  io.writeLine(`  updated: ${task.updatedAt}`);
  if (task.definition.approval.required) {
    io.writeLine(
      `  approval: required, granted at ${task.approvalGrantedAt ?? "pending"}`,
    );
  }
  if (inspection.failureReason !== null) {
    io.writeLine(`  failure reason: ${inspection.failureReason}`);
  }

  io.writeLine("attempts:");
  if (inspection.attempts.length === 0) {
    io.writeLine("  (none)");
  }
  for (const attempt of inspection.attempts) {
    io.writeLine(`  #${attempt.number} ${attempt.id} [${attempt.status}]`);
    io.writeLine(`    agent: ${attempt.agent}${attempt.model === null ? "" : ` (${attempt.model})`}`);
    io.writeLine(`    base revision: ${attempt.baseRevision}`);
    io.writeLine(`    started: ${attempt.startedAt}`);
    if (attempt.finishedAt !== null) {
      io.writeLine(`    finished: ${attempt.finishedAt}`);
    }
    if (attempt.failure !== null) {
      io.writeLine(
        `    failure: ${attempt.failure.kind}${attempt.failure.message === null ? "" : `: ${attempt.failure.message}`}`,
      );
    }
    renderStages(io, attempt.stages);
    renderVerification(io, "verification", attempt.verification);
    renderVerification(io, "integration verification", attempt.integrationVerification);
    if (attempt.commit !== null) {
      io.writeLine(`    commit: ${attempt.commit.revision} (${attempt.commit.message})`);
    }
    if (attempt.integration !== null) {
      io.writeLine(
        `    integration: ${attempt.integration.kind} at ${attempt.integration.revision}`,
      );
    }
  }

  renderClaims(io, inspection);
  renderIntegrationQueue(io, inspection);

  io.writeLine("recovery events:");
  if (inspection.recoveryEvents.length === 0) {
    io.writeLine("  (none)");
  }
  for (const event of inspection.recoveryEvents) {
    io.writeLine(
      `  #${event.sequence} ${event.type} @ ${event.occurredAt}`,
    );
  }

  io.writeLine("events:");
  if (inspection.events.length === 0) {
    io.writeLine("  (none)");
  }
  for (const event of inspection.events) {
    io.writeLine(
      `  #${event.sequence} ${event.type} @ ${event.occurredAt}`,
    );
    if (event.type === "task.routing.decided") {
      renderRoutingDecision(io, event);
    }
  }
}

const AGENT_TIERS = new Set(["economy", "standard", "strong"]);

function renderRoutingDecision(
  io: CliIo,
  event: TaskInspectionEvent,
): void {
  const payload = event.payload;
  if (!isRecord(payload)) {
    io.writeLine("    routing decision: details unavailable");
    return;
  }
  const profileId = payload["profileId"];
  const selectedTier = payload["selectedTier"];
  const minimumTier = payload["minimumTier"];
  const attemptCount = payload["attemptCount"];
  if (
    (profileId !== null && typeof profileId !== "string") ||
    (selectedTier !== null && !isAgentTier(selectedTier)) ||
    !isAgentTier(minimumTier) ||
    typeof attemptCount !== "number" ||
    !Number.isInteger(attemptCount) ||
    attemptCount < 0 ||
    (typeof profileId === "string" && selectedTier === null)
  ) {
    io.writeLine("    routing decision: details unavailable");
    return;
  }
  const reason =
    typeof payload["reason"] === "string" && payload["reason"].length > 0
      ? payload["reason"]
      : "reason unavailable";
  const route =
    profileId === null
      ? `no eligible profile (minimum ${minimumTier}; attempts ${String(attemptCount)})`
      : `profile "${profileId}" (tier ${selectedTier}; minimum ${minimumTier}; attempts ${String(attemptCount)})`;
  io.writeLine(`    routing: ${route} — ${reason}`);
}

function isAgentTier(value: unknown): value is "economy" | "standard" | "strong" {
  return typeof value === "string" && AGENT_TIERS.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderStages(
  io: CliIo,
  stages: readonly TaskInspectionStage[],
): void {
  if (stages.length === 0) {
    return;
  }
  io.writeLine("    stages:");
  for (const stage of stages) {
    const timing =
      stage.startedAt === null
        ? ""
        : ` (${stage.startedAt} -> ${stage.finishedAt ?? "open"})`;
    io.writeLine(`      ${stage.stage} [${stage.status}]${timing}`);
    if (stage.failure !== null) {
      io.writeLine(
        `        failure: ${stage.failure.kind}${stage.failure.message === null ? "" : `: ${stage.failure.message}`}`,
      );
    }
  }
}

function renderVerification(
  io: CliIo,
  label: string,
  verification: TaskInspectionVerification | null,
): void {
  if (verification === null) {
    return;
  }
  io.writeLine(`    ${label}: ${verification.status}`);
  for (const check of verification.checks) {
    io.writeLine(
      `      ${check.kind} [${check.outcome}]${check.message === null ? "" : `: ${check.message}`}`,
    );
  }
}

function renderClaims(io: CliIo, inspection: TaskInspection): void {
  io.writeLine("execution claims:");
  if (inspection.claims.length === 0) {
    io.writeLine("  (none)");
  }
  for (const claim of inspection.claims) {
    io.writeLine(
      `  ${claim.executionId} [${claim.status}] claimed ${claim.claimedAt}, lease until ${claim.leaseExpiresAt}`,
    );
  }
}

function renderIntegrationQueue(io: CliIo, inspection: TaskInspection): void {
  io.writeLine("integration queue:");
  if (inspection.integrationQueue.length === 0) {
    io.writeLine("  (none)");
  }
  for (const entry of inspection.integrationQueue) {
    io.writeLine(
      `  #${entry.sequence} ${entry.id} [${entry.status}] ${entry.taskRevision} via ${entry.branch}`,
    );
    io.writeLine(`    enqueued: ${entry.enqueuedAt}`);
    if (entry.finishedAt !== null) {
      io.writeLine(`    finished: ${entry.finishedAt}`);
    }
    if (entry.failureMessage !== null) {
      io.writeLine(`    failure: ${entry.failureMessage}`);
    }
  }
}
