import type { ExecutionClaimId, TaskId } from "./ids.js";
import type { IsoTimestamp } from "./timestamp.js";

export const EXECUTION_CLAIM_STATUSES = [
  "ACTIVE",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "RECOVERY_REQUIRED",
] as const;

export type ExecutionClaimStatus = (typeof EXECUTION_CLAIM_STATUSES)[number];

export type ExecutionClaim = {
  readonly id: ExecutionClaimId;
  readonly taskId: TaskId;
  readonly status: ExecutionClaimStatus;
  readonly claimedAt: IsoTimestamp;
  readonly finishedAt?: IsoTimestamp | undefined;
  readonly failure?: { readonly message: string } | undefined;
};
