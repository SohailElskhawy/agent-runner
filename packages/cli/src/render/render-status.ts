import type { CliIo } from "../io.js";
import type { ProjectStatus, SchedulerStatus } from "../application/ports.js";

export function renderProjectStatus(io: CliIo, status: ProjectStatus): void {
  if (status.project === null) {
    io.writeLine("runner state is not initialized");
    io.writeLine('run "agentic init" inside a Git repository to create local runner state');
    return;
  }
  const project = status.project;
  io.writeLine(`project: ${project.id}`);
  io.writeLine(`  name: ${project.name}`);
  io.writeLine(`  root: ${project.rootPath}`);
  if (status.tasks.length === 0) {
    io.writeLine("tasks: (none)");
  } else {
    io.writeLine("tasks:");
    for (const task of status.tasks) {
      const approvalSuffix =
        task.approval?.required === true && !task.approval.granted
          ? " [approval required]"
          : "";
      io.writeLine(`  ${task.id} [${task.status}] ${task.title}${approvalSuffix}`);
      io.writeLine(`    updated: ${task.updatedAt}`);
      io.writeLine(`    attempts: ${task.attemptCount}`);
      const attempt = task.latestAttempt;
      if (attempt === null) {
        continue;
      }
      io.writeLine(`    latest attempt: #${attempt.number} ${attempt.id} [${attempt.status}]`);
      io.writeLine(`      started: ${attempt.startedAt}`);
      if (attempt.finishedAt !== null) {
        io.writeLine(`      finished: ${attempt.finishedAt}`);
      }
      if (attempt.failureMessage !== null) {
        io.writeLine(`      failure: ${attempt.failureMessage}`);
      }
    }
  }
  renderScheduler(io, status.scheduler);
}

function renderScheduler(io: CliIo, scheduler: SchedulerStatus): void {
  const totals = Object.entries(scheduler.totalsByState)
    .filter(([, count]) => count > 0)
    .map(([state, count]) => `${count} ${state}`)
    .join(", ");
  io.writeLine(`task totals: ${totals.length === 0 ? "no tasks" : totals}`);
  io.writeLine(`active tasks: ${describeList(scheduler.activeTaskIds)}`);
  io.writeLine(`failed tasks: ${describeList(scheduler.failedTaskIds)}`);
  io.writeLine(`blocked tasks: ${describeList(scheduler.blockedTaskIds)}`);
  io.writeLine(`recovery required: ${describeRecovery(scheduler)}`);
  io.writeLine(
    `active execution claims: ${describeClaims(scheduler.activeClaims)}`,
  );
  const queue = scheduler.integrationQueue;
  io.writeLine(
    `integration queue: ${String(queue.totalsByStatus.PENDING)} pending, ` +
      `${String(queue.totalsByStatus.INTEGRATING)} integrating, ` +
      `${String(queue.totalsByStatus.COMPLETED)} completed, ` +
      `${String(queue.totalsByStatus.FAILED)} failed`,
  );
  if (queue.integrating !== null) {
    io.writeLine(
      `  integrating: ${queue.integrating.taskId} (attempt ${queue.integrating.attemptId})`,
    );
  }
  if (queue.pendingTaskIds.length > 0) {
    io.writeLine(`  pending: ${queue.pendingTaskIds.join(", ")}`);
  }
  const capacity = scheduler.parallelCapacity;
  io.writeLine(
    `parallel capacity: ${String(capacity.maxParallelism)} configured, ` +
      `${String(capacity.activeExecutions)} active, ` +
      `${String(capacity.remainingSlots)} available`,
  );
}

function describeList(taskIds: readonly string[]): string {
  return taskIds.length === 0 ? "(none)" : taskIds.join(", ");
}

function describeRecovery(scheduler: SchedulerStatus): string {
  const taskIds = scheduler.recoveryRequiredTaskIds;
  const claims = scheduler.recoveryRequiredClaims;
  if (taskIds.length === 0 && claims.length === 0) {
    return "(none)";
  }
  const parts: string[] = [];
  if (taskIds.length > 0) {
    parts.push(`tasks: ${taskIds.join(", ")}`);
  }
  if (claims.length > 0) {
    parts.push(
      `claims: ${claims
        .map((claim) => `${claim.executionId} (${claim.taskId})`)
        .join(", ")}`,
    );
  }
  return parts.join("; ");
}

function describeClaims(
  claims: SchedulerStatus["activeClaims"],
): string {
  if (claims.length === 0) {
    return "(none)";
  }
  return claims
    .map(
      (claim) =>
        `${claim.executionId} on ${claim.taskId} (lease until ${claim.leaseExpiresAt})`,
    )
    .join(", ");
}
