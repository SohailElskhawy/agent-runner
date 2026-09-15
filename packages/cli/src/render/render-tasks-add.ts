import type { CliIo } from "../io.js";
import type { AddTaskResult } from "../application/ports.js";

export function renderTaskAddResult(io: CliIo, result: AddTaskResult): void {
  io.writeLine(`task "${result.taskId}" added to project "${result.projectId}"`);
  io.writeLine(`  title: ${result.title}`);
  io.writeLine(`  status: ${result.status}`);
}
