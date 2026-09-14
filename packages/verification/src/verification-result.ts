import type {
  AttemptId,
  IsoTimestamp,
  VerificationFailure,
  VerificationKind,
  VerificationOutcome,
  VerificationResultId,
} from "@agentic-dev-runner/core";

export type VerificationRunStatus = "PASSED" | "FAILED" | "CANCELLED";

export type VerificationCheckResult = {
  readonly id: VerificationResultId;
  readonly attemptId: AttemptId;
  readonly name: string;
  readonly kind: VerificationKind;
  readonly command: readonly string[];
  readonly outcome: VerificationOutcome;
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly startedAt: IsoTimestamp | undefined;
  readonly finishedAt: IsoTimestamp | undefined;
  readonly failure?: VerificationFailure;
};

export type VerificationRunResult = {
  readonly attemptId: AttemptId;
  readonly cwd: string;
  readonly startedAt: IsoTimestamp;
  readonly finishedAt: IsoTimestamp;
  readonly checks: readonly VerificationCheckResult[];
  readonly status: VerificationRunStatus;
  readonly passed: boolean;
  readonly cancelled: boolean;
};
