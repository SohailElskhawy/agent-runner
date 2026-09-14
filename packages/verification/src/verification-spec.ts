import type {
  AttemptId,
  VerificationKind,
} from "@agentic-dev-runner/core";

export type VerificationCheckSpec = {
  readonly name: string;
  readonly executable: string;
  readonly args?: readonly string[] | undefined;
  readonly kind?: VerificationKind | undefined;
  readonly timeoutMs?: number | undefined;
};

export type VerificationRunInput = {
  readonly attemptId: AttemptId;
  readonly cwd: string;
  readonly checks: readonly VerificationCheckSpec[];
  readonly signal?: AbortSignal | undefined;
};
