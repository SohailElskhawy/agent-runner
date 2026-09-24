import type { CliIo } from "../io.js";
import type {
  TaskInspection,
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
  }
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
