import type { IsoTimestamp, TaskId } from "@agentic-dev-runner/core";

export type StoredEvent = {
  id: string;
  type: string;
  taskId: TaskId | null;
  payload: unknown;
  occurredAt: IsoTimestamp;
  sequence: number;
};

export type NewEvent = {
  type: string;
  taskId: TaskId | null;
  payload: unknown;
  occurredAt: IsoTimestamp;
};
