import type { TaskId } from "@agentic-dev-runner/core";
import type { SingleTaskRunOutcome } from "@agentic-dev-runner/orchestrator";
import type {
  InitResult,
  ProjectStatus,
  RunResult,
  TaskInspection,
} from "./ports.js";

export interface RunnerAppService {
  init(): Promise<InitResult>;
  run(taskId: TaskId): Promise<RunResult>;
  status(): Promise<ProjectStatus>;
  inspect(taskId: TaskId): Promise<TaskInspection | null>;
  close(): Promise<void>;
}

export function outcomeToRunResult(
  outcome: SingleTaskRunOutcome,
): RunResult {
  switch (outcome.kind) {
    case "completed":
      return {
        kind: "completed",
        message: `task "${outcome.taskId}" completed (attempt ${outcome.attemptId}, revision ${outcome.integration.revision})`,
      };
    case "failed":
      return {
        kind: "failed",
        message: `task "${outcome.taskId}" failed: ${outcome.reason}`,
      };
    case "cancelled":
      return {
        kind: "cancelled",
        message: `task "${outcome.taskId}" was cancelled: ${outcome.reason}`,
      };
    case "rejected":
      return {
        kind: "rejected",
        message: `task "${outcome.taskId}" was rejected: ${outcome.reason}`,
      };
  }
}
