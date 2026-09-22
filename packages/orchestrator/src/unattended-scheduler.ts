import type { TaskId } from "@agentic-dev-runner/core";
import type {
  IntegrationQueueProcessor,
  IntegrationQueueProcessorOutcome,
} from "./integration-queue-processor.js";
import type {
  TaskDispatchResult,
  TaskExecutionCoordinator,
} from "./task-execution-coordinator.js";

export type UnattendedSchedulerOptions = {
  readonly coordinator: TaskExecutionCoordinator;
  readonly integration: IntegrationQueueProcessor;
};

export type UnattendedSchedulerCycle = {
  readonly dispatch: TaskDispatchResult;
  readonly integrations: readonly IntegrationQueueProcessorOutcome[];
};

/** Per-run scheduling capacity; defaults to the configured coordinator capacity. */
export type UnattendedRunOptions = {
  readonly maxParallelism?: number | undefined;
};

export type UnattendedSchedulerResult = {
  readonly kind: "quiescent" | "blocked";
  readonly cycles: readonly UnattendedSchedulerCycle[];
  readonly completedTaskIds: readonly TaskId[];
  readonly failedTaskIds: readonly TaskId[];
};

export interface UnattendedScheduler {
  /** Runs until no dispatchable work or queue progress remains. */
  run(options?: UnattendedRunOptions): Promise<UnattendedSchedulerResult>;
}

export function createUnattendedScheduler(
  options: UnattendedSchedulerOptions,
): UnattendedScheduler {
  return new DurableUnattendedScheduler(options);
}

class DurableUnattendedScheduler implements UnattendedScheduler {
  private readonly coordinator: TaskExecutionCoordinator;
  private readonly integration: IntegrationQueueProcessor;
  private running = false;

  constructor(options: UnattendedSchedulerOptions) {
    this.coordinator = options.coordinator;
    this.integration = options.integration;
  }

  async run(
    options: UnattendedRunOptions = {},
  ): Promise<UnattendedSchedulerResult> {
    if (this.running) {
      throw new Error("unattended scheduler is already running");
    }
    this.running = true;
    try {
      const maxParallelism = options.maxParallelism ?? this.coordinator.maxParallelism;
      validateMaxParallelism(maxParallelism);
      const cycles: UnattendedSchedulerCycle[] = [];
      const completedTaskIds: TaskId[] = [];
      const failedTaskIds: TaskId[] = [];

      while (true) {
        const dispatch = await this.coordinator.dispatchAvailable({ maxParallelism });
        const integrations: IntegrationQueueProcessorOutcome[] = [];
        for (;;) {
          const outcome = await this.integration.processNext();
          integrations.push(outcome);
          if (outcome.kind === "blocked") {
            cycles.push({ dispatch, integrations });
            collectTaskOutcome(dispatch, completedTaskIds, failedTaskIds);
            return {
              kind: "blocked",
              cycles,
              completedTaskIds,
              failedTaskIds,
            };
          }
          if (outcome.kind === "empty") {
            break;
          }
          if (outcome.kind === "processed") {
            completedTaskIds.push(outcome.entry.taskId);
          } else {
            failedTaskIds.push(outcome.entry.taskId);
          }
        }
        cycles.push({ dispatch, integrations });
        collectTaskOutcome(dispatch, completedTaskIds, failedTaskIds);

        // A rejected workflow may leave its task READY. It is observable in
        // the cycle, but it is not progress, so the run quiesces instead of
        // repeatedly invoking the same rejected task forever.
        const executionProgress = dispatch.executions.some(
          (execution) =>
            execution.error !== undefined ||
            (execution.outcome !== undefined &&
              execution.outcome.kind !== "rejected"),
        );
        const integrationProgress = integrations.some(
          (outcome) =>
            outcome.kind === "processed" || outcome.kind === "failed",
        );
        if (
          dispatch.executions.some((execution) => execution.recoveryRequired) ||
          (dispatch.activeClaims.length > 0 &&
            !executionProgress &&
            !integrationProgress)
        ) {
          return {
            kind: "blocked",
            cycles,
            completedTaskIds,
            failedTaskIds,
          };
        }
        if (!executionProgress && !integrationProgress) {
          return {
            kind: "quiescent",
            cycles,
            completedTaskIds,
            failedTaskIds,
          };
        }
      }
    } finally {
      this.running = false;
    }
  }
}

function validateMaxParallelism(maxParallelism: number): void {
  if (!Number.isInteger(maxParallelism) || maxParallelism <= 0) {
    throw new Error(
      "unattended run maxParallelism must be a positive integer; invalid values are not normalized",
    );
  }
}

function collectTaskOutcome(
  dispatch: TaskDispatchResult,
  completedTaskIds: TaskId[],
  failedTaskIds: TaskId[],
): void {
  for (const execution of dispatch.executions) {
    if (execution.outcome?.kind === "completed") {
      completedTaskIds.push(execution.taskId);
    }
    if (
      execution.outcome?.kind === "failed" ||
      execution.outcome?.kind === "blocked" ||
      execution.outcome?.kind === "cancelled" ||
      execution.error !== undefined
    ) {
      failedTaskIds.push(execution.taskId);
    }
  }
}
