import type { TaskId } from "@agentic-dev-runner/core";
import type {
  RecoveryOutcome,
  SingleTaskRunOutcome,
  WorkflowTaskRunOutcome,
} from "@agentic-dev-runner/orchestrator";
import type {
  AddTaskResult,
  AgentStatusEntry,
  ApprovalCommandResult,
  InitResult,
  ProjectStatus,
  RetryCommandResult,
  RunResult,
  TaskInspection,
  TaskListEntry,
  UnattendedRunRequest,
} from "./ports.js";

/**
 * The single-task run seam consumed by the CLI application services. Both the
 * routed workflow path and the injected single-task orchestrator satisfy it by
 * covariance, so overrides keep working without an adapter.
 */
export interface TaskRunner {
  run(taskId: TaskId): Promise<WorkflowTaskRunOutcome>;
}

export interface RunnerAppService {
  init(): Promise<InitResult>;
  addTask(taskFilePath: string): Promise<AddTaskResult>;
  approve(taskId: TaskId): Promise<ApprovalCommandResult>;
  retry(taskId: TaskId): Promise<RetryCommandResult>;
  run(taskId: TaskId): Promise<RunResult>;
  runUnattended(options?: UnattendedRunRequest): Promise<RunResult>;
  status(): Promise<ProjectStatus>;
  listTaskSummaries(): Promise<readonly TaskListEntry[]>;
  inspect(taskId: TaskId): Promise<TaskInspection | null>;
  listAgents(): Promise<readonly AgentStatusEntry[]>;
  close(): Promise<void>;
}

export function recoveryOutcomeToRunResult(
  outcome: RecoveryOutcome,
): RunResult | null {
  switch (outcome.kind) {
    case "completed":
      return {
        kind: "completed",
        message: `task "${outcome.taskId}" was recovered to DONE (integration revision ${outcome.integration.revision})`,
      };
    case "failed":
      return {
        kind: "failed",
        message: `task "${outcome.taskId}" recovery failed: ${outcome.reason}`,
      };
    case "cancelled":
      return {
        kind: "cancelled",
        message: `task "${outcome.taskId}" recovery was cancelled: ${outcome.reason}`,
      };
    case "requires-reconciliation":
      return {
        kind: "rejected",
        message: `task "${outcome.taskId}" requires reconciliation: ${outcome.detail}`,
      };
    case "requires-human":
      return {
        kind: "rejected",
        message: `task "${outcome.taskId}" requires human intervention: ${outcome.detail}`,
      };
    case "no-op":
    case "safe-to-retry":
      return null;
  }
}

export function outcomeToRunResult(
  outcome: WorkflowTaskRunOutcome | SingleTaskRunOutcome,
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
    case "blocked":
      return {
        kind: "blocked",
        message: `task "${outcome.taskId}" was blocked: ${outcome.reason}`,
      };
    case "pending-integration":
      return {
        kind: "rejected",
        message: `task "${outcome.taskId}" was queued for integration during a single-task run; this is a wiring error`,
      };
    case "rejected":
      return {
        kind: "rejected",
        message: `task "${outcome.taskId}" was rejected: ${outcome.reason}`,
      };
  }
}
