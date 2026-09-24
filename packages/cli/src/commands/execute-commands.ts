import type { TaskId } from "@agentic-dev-runner/core";
import type { CliIo } from "../io.js";
import { renderInitResult } from "../render/render-init.js";
import { renderProjectStatus } from "../render/render-status.js";
import { renderRunResult } from "../render/render-run.js";
import { renderTaskInspection } from "../render/render-inspect.js";
import { renderTaskAddResult } from "../render/render-tasks-add.js";
import { renderAgentsReport } from "../render/render-agents.js";
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

export async function executeAddTaskCommand(
  taskFile: string,
  services: RunnerAppService,
  io: CliIo,
): Promise<number> {
  const result = await services.addTask(taskFile);
  renderTaskAddResult(io, result);
  return EXIT_SUCCESS;
}

export async function executeApproveCommand(
  taskId: TaskId,
  services: RunnerAppService,
  io: CliIo,
): Promise<number> {
  const result = await services.approve(taskId);
  if (result.kind === "rejected") {
    io.writeError(result.message);
    return EXIT_FAILURE;
  }
  io.writeLine(result.message);
  return EXIT_SUCCESS;
}

export async function executeRetryCommand(
  taskId: TaskId,
  services: RunnerAppService,
  io: CliIo,
): Promise<number> {
  const result = await services.retry(taskId);
  if (result.kind === "rejected") {
    io.writeError(result.message);
    return EXIT_FAILURE;
  }
  io.writeLine(result.message);
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

export async function executeUnattendedRunCommand(
  parallel: number | undefined,
  services: RunnerAppService,
  io: CliIo,
): Promise<number> {
  const result = await services.runUnattended(
    parallel === undefined ? {} : { maxParallelism: parallel },
  );
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

export async function executeAgentsCommand(
  services: RunnerAppService,
  io: CliIo,
): Promise<number> {
  const agents = await services.listAgents();
  renderAgentsReport(io, agents);
  return EXIT_SUCCESS;
}
