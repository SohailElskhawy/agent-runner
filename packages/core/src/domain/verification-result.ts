import type { IsoTimestamp } from "./timestamp.js";

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
  id: string;
  attemptId: string;
  kind: VerificationKind;
  command: readonly string[];
  outcome: VerificationOutcome;
  exitCode?: number;
  startedAt: IsoTimestamp;
  finishedAt?: IsoTimestamp;
  failure?: VerificationFailure;
};
