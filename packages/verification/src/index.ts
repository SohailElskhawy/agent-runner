export { VerificationSpecError } from "./errors.js";
export type {
  VerificationCheckResult,
  VerificationRunResult,
  VerificationRunStatus,
} from "./verification-result.js";
export type {
  VerificationCheckSpec,
  VerificationRunInput,
} from "./verification-spec.js";
export {
  createVerificationEngine,
  DEFAULT_FAIL_FAST,
  DEFAULT_MAX_OUTPUT_CHARS,
  type VerificationEngine,
  type VerificationEngineOptions,
} from "./verification-engine.js";
export { toVerificationResults } from "./to-verification-results.js";
export {
  resolveVerificationChecksForTask,
  toVerificationCheckSpecs,
  type TaskVerificationCheckResolution,
} from "./verification-check-resolution.js";
