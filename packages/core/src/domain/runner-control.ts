import type { ProjectId } from "./ids.js";
import type { IsoTimestamp } from "./timestamp.js";

export const RUNNER_CONTROL_STATES = ["RUNNING", "PAUSED"] as const;
export type RunnerControlState = (typeof RUNNER_CONTROL_STATES)[number];
export type RunnerControlStatus = {
  readonly projectId: ProjectId;
  readonly state: RunnerControlState;
  readonly pausedAt?: IsoTimestamp | undefined;
  readonly pauseReason?: string | undefined;
  readonly updatedAt: IsoTimestamp;
};
