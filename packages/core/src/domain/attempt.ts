import type { IsoTimestamp } from "./timestamp.js";
import type { AttemptId, TaskId } from "./ids.js";
import type { ContextManifest } from "./context-manifest.js";
import type { InvocationUsageObservation } from "./invocation-usage.js";

export const ATTEMPT_STATUSES = [
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
] as const;

export type AttemptExecutionMode = "single-task" | "workflow";

export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export type AttemptFailure = {
  kind: "error" | "timeout" | "cancelled" | "verification_failed";
  message?: string;
};

export type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
};

export type AttemptLogs = {
  stdout?: string;
  stderr?: string;
  location?: string;
};

export type Attempt = {
  id: AttemptId;
  taskId: TaskId;
  number: number;
  status: AttemptStatus;
  executionMode?: AttemptExecutionMode;
  agent: string;
  model?: string;
  baseRevision: string;
  contextManifest?: ContextManifest;
  logs?: AttemptLogs;
  tokenUsage?: TokenUsage;
  cost?: number;
  /**
   * Usage observation for the single invocation of a single-task attempt
   * (D-AP-6). Distinct from the legacy, unverified `tokenUsage`/`cost`.
   */
  invocationUsage?: InvocationUsageObservation;
  startedAt: IsoTimestamp;
  finishedAt?: IsoTimestamp;
  failure?: AttemptFailure;
};
