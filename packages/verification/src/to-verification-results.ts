import type { IsoTimestamp, VerificationResult } from "@agentic-dev-runner/core";
import type { VerificationCheckResult, VerificationRunResult } from "./verification-result.js";

export function toVerificationResults(
  run: VerificationRunResult,
): VerificationResult[] {
  return run.checks.map((check) => toVerificationResult(check, run.startedAt));
}

function toVerificationResult(
  check: VerificationCheckResult,
  runStartedAt: IsoTimestamp,
): VerificationResult {
  const result: VerificationResult = {
    id: check.id,
    attemptId: check.attemptId,
    kind: check.kind,
    command: check.command,
    outcome: check.outcome,
    startedAt: check.startedAt ?? runStartedAt,
  };
  if (check.exitCode !== undefined) {
    result.exitCode = check.exitCode;
  }
  if (check.finishedAt !== undefined) {
    result.finishedAt = check.finishedAt;
  }
  if (check.failure !== undefined) {
    result.failure = check.failure;
  }
  return result;
}
