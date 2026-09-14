import type { IsoTimestamp } from "./timestamp.js";
import type { AttemptId, TaskId } from "./ids.js";
import type { ContextManifest } from "./context-manifest.js";

export const ATTEMPT_STATUSES = [
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
] as const;

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
  agent: string;
  model?: string;
  baseRevision: string;
  contextManifest?: ContextManifest;
  logs?: AttemptLogs;
  tokenUsage?: TokenUsage;
  cost?: number;
  startedAt: IsoTimestamp;
  finishedAt?: IsoTimestamp;
  failure?: AttemptFailure;
};
