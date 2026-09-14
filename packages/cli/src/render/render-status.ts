import type { CliIo } from "../io.js";
import type { ProjectStatus } from "../application/ports.js";

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
    return;
  }
  io.writeLine("tasks:");
  for (const task of status.tasks) {
    io.writeLine(`  ${task.id} [${task.status}] ${task.title}`);
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
