import type { Project, Task } from "@agentic-dev-runner/core";

export type InitResult = {
  readonly projectId: string;
  readonly projectRoot: string;
  readonly storePath: string;
};

export type AddTaskResult = {
  readonly taskId: string;
  readonly projectId: string;
  readonly title: string;
  readonly status: Task["status"];
};

export type RunResult =
  | { readonly kind: "completed"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "cancelled"; readonly message: string }
  | { readonly kind: "rejected"; readonly message: string };

/** Per-run unattended scheduling request. */
export type UnattendedRunRequest = {
  readonly maxParallelism?: number | undefined;
};

export type AgentStatusEntry = {
  readonly id: string;
  readonly available: boolean;
  readonly version: string | null;
  readonly reason: string | null;
};

export type ProjectStatus = {
  readonly project: Project | null;
  readonly tasks: readonly TaskStatusEntry[];
};

export type TaskStatusEntry = {
  readonly id: string;
  readonly title: string;
  readonly status: Task["status"];
  readonly updatedAt: string;
  readonly attemptCount: number;
  readonly latestAttempt: LatestAttemptSummary | null;
};

export type LatestAttemptSummary = {
  readonly id: string;
  readonly number: number;
  readonly status: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly failureMessage: string | null;
};

export type TaskInspection = {
  readonly task: Task;
  readonly attempts: readonly TaskInspectionAttempt[];
  readonly events: readonly TaskInspectionEvent[];
};

export type TaskInspectionAttempt = {
  readonly id: string;
  readonly number: number;
  readonly status: string;
  readonly agent: string;
  readonly model: string | null;
  readonly baseRevision: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly failure: { readonly kind: string; readonly message: string | null } | null;
  readonly commit: { readonly revision: string; readonly message: string } | null;
  readonly integration: { readonly revision: string; readonly kind: string } | null;
};

export type TaskInspectionEvent = {
  readonly sequence: number;
  readonly type: string;
  readonly occurredAt: string;
  readonly payload: unknown;
};
