import type { VerificationCheckDefinition } from "@agentic-dev-runner/core";
import type { VerificationCheckSpec } from "./verification-spec.js";

export type TaskVerificationCheckResolution =
  | { readonly ok: true; readonly checks: readonly VerificationCheckSpec[] }
  | { readonly ok: false; readonly missingChecks: readonly string[] };

export function toVerificationCheckSpecs(
  definitions: readonly VerificationCheckDefinition[],
): VerificationCheckSpec[] {
  return definitions.map((definition) => ({
    name: definition.name,
    executable: definition.command,
    args: [...definition.args],
  }));
}

export function resolveVerificationChecksForTask(
  required: readonly string[],
  configured: readonly VerificationCheckSpec[],
): TaskVerificationCheckResolution {
  const missingChecks = required.filter(
    (name) => !configured.some((check) => check.name === name),
  );
  if (missingChecks.length > 0) {
    return { ok: false, missingChecks };
  }
  const checks: VerificationCheckSpec[] = [];
  for (const name of required) {
    const check = configured.find((candidate) => candidate.name === name);
    if (check === undefined) {
      continue;
    }
    checks.push(check);
  }
  return { ok: true, checks };
}
