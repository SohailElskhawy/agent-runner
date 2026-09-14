import { randomUUID } from "node:crypto";
import { VERIFICATION_KINDS } from "@agentic-dev-runner/core";
import type {
  AttemptId,
  IsoTimestamp,
  VerificationFailure,
  VerificationKind,
  VerificationOutcome,
  VerificationResultId,
} from "@agentic-dev-runner/core";
import type {
  ProcessOutcome,
  ProcessResult,
  ProcessRunner,
  ProcessSpec,
} from "@agentic-dev-runner/platform";
import { VerificationSpecError } from "./errors.js";
import type {
  VerificationCheckResult,
  VerificationRunResult,
  VerificationRunStatus,
} from "./verification-result.js";
import type {
  VerificationCheckSpec,
  VerificationRunInput,
} from "./verification-spec.js";

export const DEFAULT_FAIL_FAST = true;

export const DEFAULT_MAX_OUTPUT_CHARS = 200_000;

export type VerificationEngineOptions = {
  readonly runner: ProcessRunner;
  readonly failFast?: boolean | undefined;
  readonly maxOutputChars?: number | undefined;
  readonly resultIdFactory?: (() => VerificationResultId) | undefined;
};

export interface VerificationEngine {
  run(input: VerificationRunInput): Promise<VerificationRunResult>;
}

export function createVerificationEngine(
  options: VerificationEngineOptions,
): VerificationEngine {
  return new SequentialVerificationEngine(options);
}

class SequentialVerificationEngine implements VerificationEngine {
  private readonly runner: ProcessRunner;
  private readonly failFast: boolean;
  private readonly maxOutputChars: number;
  private readonly resultIdFactory: () => VerificationResultId;

  constructor(options: VerificationEngineOptions) {
    validateEngineOptions(options);
    this.runner = options.runner;
    this.failFast = options.failFast ?? DEFAULT_FAIL_FAST;
    this.maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    this.resultIdFactory = options.resultIdFactory ?? defaultResultIdFactory;
  }

  async run(input: VerificationRunInput): Promise<VerificationRunResult> {
    validateRunInput(input);
    const startedAt = now();
    const checks: VerificationCheckResult[] = [];
    let aborted = false;

    for (const check of input.checks) {
      if (input.signal?.aborted === true) {
        aborted = true;
        break;
      }
      const checkResult = await this.runCheck(input, check);
      checks.push(checkResult);
      if (checkResult.outcome === "CANCELLED") {
        aborted = true;
        break;
      }
      if (this.failFast && checkResult.outcome === "FAILED") {
        break;
      }
    }

    const finishedAt = now();
    const status = resolveRunStatus(input.checks.length, checks, aborted);
    return {
      attemptId: input.attemptId,
      cwd: input.cwd,
      startedAt,
      finishedAt,
      checks,
      status,
      passed: status === "PASSED",
      cancelled: status === "CANCELLED",
    };
  }

  private async runCheck(
    input: VerificationRunInput,
    check: VerificationCheckSpec,
  ): Promise<VerificationCheckResult> {
    const id = this.resultIdFactory();
    const kind = resolveVerificationKind(check);
    const command = [check.executable, ...(check.args ?? [])];
    const startedAt = now();
    const processResult = await this.runner.run(buildProcessSpec(input, check));
    const finishedAt = now();
    return normalizeProcessResult({
      id,
      attemptId: input.attemptId,
      check,
      kind,
      command,
      startedAt,
      finishedAt,
      processResult,
      maxOutputChars: this.maxOutputChars,
    });
  }
}

type NormalizeInput = {
  readonly id: VerificationResultId;
  readonly attemptId: AttemptId;
  readonly check: VerificationCheckSpec;
  readonly kind: VerificationKind;
  readonly command: readonly string[];
  readonly startedAt: IsoTimestamp;
  readonly finishedAt: IsoTimestamp;
  readonly processResult: ProcessResult;
  readonly maxOutputChars: number;
};

function normalizeProcessResult(input: NormalizeInput): VerificationCheckResult {
  const stdout = truncateOutput(input.processResult.stdout, input.maxOutputChars);
  const stderr = truncateOutput(input.processResult.stderr, input.maxOutputChars);
  const failure = buildFailure(input.check, input.processResult.outcome, stdout, stderr);
  return {
    id: input.id,
    attemptId: input.attemptId,
    name: input.check.name,
    kind: input.kind,
    command: input.command,
    outcome: normalizeOutcome(input.processResult.outcome),
    stdout,
    stderr,
    durationMs: input.processResult.durationMs,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    ...(input.processResult.outcome.kind === "completed"
      ? { exitCode: input.processResult.outcome.code }
      : {}),
    ...(failure === undefined ? {} : { failure }),
  };
}

function normalizeOutcome(processOutcome: ProcessOutcome): VerificationOutcome {
  switch (processOutcome.kind) {
    case "completed":
      return processOutcome.code === 0 ? "PASSED" : "FAILED";
    case "terminated":
    case "timeout":
    case "spawn-error":
      return "FAILED";
    case "cancelled":
      return "CANCELLED";
  }
}

function buildFailure(
  check: VerificationCheckSpec,
  processOutcome: ProcessOutcome,
  stdout: string,
  stderr: string,
): VerificationFailure | undefined {
  if (processOutcome.kind === "completed" && processOutcome.code === 0) {
    return undefined;
  }
  const message = describeProcessOutcome(check, processOutcome);
  const output = combineOutput(stdout, stderr);
  return output === undefined ? { message } : { message, output };
}

function describeProcessOutcome(
  check: VerificationCheckSpec,
  outcome: ProcessOutcome,
): string {
  switch (outcome.kind) {
    case "completed":
      return `verification command "${check.name}" exited with code ${String(outcome.code)}`;
    case "terminated":
      return `verification command "${check.name}" was terminated by signal ${outcome.signal}`;
    case "timeout":
      return check.timeoutMs === undefined
        ? `verification command "${check.name}" timed out`
        : `verification command "${check.name}" timed out after ${String(check.timeoutMs)} ms`;
    case "cancelled":
      return `verification command "${check.name}" was cancelled`;
    case "spawn-error":
      return `verification command "${check.name}" failed to start (${outcome.code}): ${outcome.message}`;
  }
}

function buildProcessSpec(
  input: VerificationRunInput,
  check: VerificationCheckSpec,
): ProcessSpec {
  return {
    executable: check.executable,
    args: check.args === undefined ? undefined : [...check.args],
    cwd: input.cwd,
    timeoutMs: check.timeoutMs,
    signal: input.signal,
  };
}

function resolveVerificationKind(check: VerificationCheckSpec): VerificationKind {
  if (check.kind !== undefined) {
    return check.kind;
  }
  return VERIFICATION_KINDS.find((kind) => kind === check.name) ?? "custom";
}

function resolveRunStatus(
  configuredCount: number,
  checks: readonly VerificationCheckResult[],
  aborted: boolean,
): VerificationRunStatus {
  if (aborted) {
    return "CANCELLED";
  }
  if (
    checks.length === configuredCount &&
    checks.every((check) => check.outcome === "PASSED")
  ) {
    return "PASSED";
  }
  return "FAILED";
}

function truncateOutput(output: string, maxChars: number): string {
  if (output.length <= maxChars) {
    return output;
  }
  const omitted = output.length - maxChars;
  return `${output.slice(0, maxChars)}\n[verification output truncated: ${String(omitted)} chars omitted]`;
}

function combineOutput(stdout: string, stderr: string): string | undefined {
  if (stdout.length === 0) {
    return stderr.length === 0 ? undefined : stderr;
  }
  return stderr.length === 0 ? stdout : `${stdout}\n${stderr}`;
}

function validateEngineOptions(options: VerificationEngineOptions): void {
  if (options.failFast !== undefined && typeof options.failFast !== "boolean") {
    throw new VerificationSpecError("failFast must be a boolean");
  }
  if (
    options.maxOutputChars !== undefined &&
    (!Number.isInteger(options.maxOutputChars) || options.maxOutputChars <= 0)
  ) {
    throw new VerificationSpecError(
      "maxOutputChars must be a positive integer",
    );
  }
  if (
    options.resultIdFactory !== undefined &&
    typeof options.resultIdFactory !== "function"
  ) {
    throw new VerificationSpecError("resultIdFactory must be a function");
  }
}

function validateRunInput(input: VerificationRunInput): void {
  requireNonEmptyString(input.attemptId, "attemptId");
  requireNonEmptyString(input.cwd, "cwd");
  if (!Array.isArray(input.checks)) {
    throw new VerificationSpecError("checks must be an array");
  }
  for (const check of input.checks) {
    validateCheckSpec(check);
  }
}

function validateCheckSpec(check: VerificationCheckSpec): void {
  requireNonEmptyString(check.name, "check name");
  requireNonEmptyString(check.executable, `check "${check.name}" executable`);
  if (check.args !== undefined) {
    if (
      !Array.isArray(check.args) ||
      check.args.some((arg) => typeof arg !== "string")
    ) {
      throw new VerificationSpecError(
        `check "${check.name}" args must be an array of strings`,
      );
    }
  }
  if (check.kind !== undefined && !VERIFICATION_KINDS.includes(check.kind)) {
    throw new VerificationSpecError(
      `check "${check.name}" kind is not a supported verification kind`,
    );
  }
  if (
    check.timeoutMs !== undefined &&
    (!Number.isFinite(check.timeoutMs) || check.timeoutMs <= 0)
  ) {
    throw new VerificationSpecError(
      `check "${check.name}" timeoutMs must be a positive finite number`,
    );
  }
}

function requireNonEmptyString(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new VerificationSpecError(`${label} must be a non-empty string`);
  }
}

function now(): IsoTimestamp {
  return new Date().toISOString();
}

const defaultResultIdFactory = (): VerificationResultId =>
  `ver_${randomUUID()}`;
