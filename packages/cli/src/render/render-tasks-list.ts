import type { CliIo } from "../io.js";
import type { TaskListEntry } from "../application/ports.js";

export function renderTasksList(
  io: CliIo,
  tasks: readonly TaskListEntry[],
): void {
  if (tasks.length === 0) {
    io.writeLine(
      'no tasks are persisted; add one with "agentic tasks add <task-file>"',
    );
    return;
  }
  for (const task of tasks) {
    const flags = [
      `attempts: ${String(task.attemptCount)}`,
      ...(task.dependsOn.length === 0
        ? []
        : [`depends on: ${task.dependsOn.join(", ")}`]),
      ...(task.approvalRequired
        ? [task.approvalGranted ? "approval: granted" : "approval: required"]
        : []),
    ];
    io.writeLine(
      `[${task.status}] ${task.id} (${task.priority}, ${task.milestone}) ${task.title} — ${flags.join(", ")}`,
    );
  }
}
