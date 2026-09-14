import type { CliIo } from "../io.js";
import type { TaskInspection } from "../application/ports.js";

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
    if (attempt.commit !== null) {
      io.writeLine(`    commit: ${attempt.commit.revision} (${attempt.commit.message})`);
    }
    if (attempt.integration !== null) {
      io.writeLine(
        `    integration: ${attempt.integration.kind} at ${attempt.integration.revision}`,
      );
    }
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
