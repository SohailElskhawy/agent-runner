import type { TaskId } from "@agentic-dev-runner/core";
import type { CliIo } from "../io.js";
import { renderInitResult } from "../render/render-init.js";
import { renderProjectStatus } from "../render/render-status.js";
import { renderRunResult } from "../render/render-run.js";
import { renderTaskInspection } from "../render/render-inspect.js";
import type { RunnerAppService } from "../application/runner-app-service.js";

export const EXIT_SUCCESS = 0;
export const EXIT_FAILURE = 1;

export async function executeInitCommand(
  services: RunnerAppService,
  io: CliIo,
): Promise<number> {
  const result = await services.init();
  renderInitResult(io, result);
  return EXIT_SUCCESS;
}

export async function executeRunCommand(
  taskId: TaskId,
  services: RunnerAppService,
  io: CliIo,
): Promise<number> {
  const result = await services.run(taskId);
  renderRunResult(io, result);
  return result.kind === "completed" ? EXIT_SUCCESS : EXIT_FAILURE;
}

export async function executeStatusCommand(
  services: RunnerAppService,
  io: CliIo,
): Promise<number> {
  const status = await services.status();
  renderProjectStatus(io, status);
  return EXIT_SUCCESS;
}

export async function executeInspectCommand(
  taskId: TaskId,
  services: RunnerAppService,
  io: CliIo,
): Promise<number> {
  const inspection = await services.inspect(taskId);
  if (inspection === null) {
    io.writeError(`task "${taskId}" was not found in runner state`);
    return EXIT_FAILURE;
  }
  renderTaskInspection(io, inspection);
  return EXIT_SUCCESS;
}
