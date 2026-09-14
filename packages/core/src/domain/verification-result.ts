import type { IsoTimestamp } from "./timestamp.js";
import type { AttemptId, VerificationResultId } from "./ids.js";

export const VERIFICATION_KINDS = [
  "typecheck",
  "lint",
  "unit",
  "integration",
  "e2e",
  "build",
  "security",
  "custom",
] as const;

export type VerificationKind = (typeof VERIFICATION_KINDS)[number];

export type VerificationOutcome = "PASSED" | "FAILED" | "CANCELLED";

export type VerificationFailure = {
  message: string;
  output?: string;
};

export type VerificationResult = {
  id: VerificationResultId;
  attemptId: AttemptId;
  kind: VerificationKind;
  command: readonly string[];
  outcome: VerificationOutcome;
  exitCode?: number;
  startedAt: IsoTimestamp;
  finishedAt?: IsoTimestamp;
  failure?: VerificationFailure;
};
