/**
 * Provider-independent agent capability profiles.
 *
 * An `AgentProfile` describes an agent candidate available to the runner:
 * its stable profile id, the adapter that executes it, an optional model
 * identifier, and the task capabilities it has explicitly declared.
 *
 * Capability normalization (identical on both sides of a match):
 * - surrounding whitespace is trimmed
 * - the label is lowercased
 * - every other character (hyphens, dots, internal spaces, ...) is preserved,
 *   so "React Native" and "react-native" are different capabilities
 *
 * Matching is exact string equality after normalization and is purely
 * deterministic. Task capability labels are opaque domain strings; provider
 * runtime features (streaming, token reporting, ...) are runtime concepts and
 * must never be expressed through this model.
 */

export type AgentProfile = {
  readonly id: string;
  readonly adapterId: string;
  readonly model?: string | undefined;
  readonly capabilities: readonly string[];
};

export type AgentProfileValidationResult =
  | { readonly ok: true; readonly value: AgentProfile }
  | { readonly ok: false; readonly issues: readonly string[] };

export type AgentProfileEligibility =
  | { readonly eligible: true; readonly missingCapabilities: readonly [] }
  | { readonly eligible: false; readonly missingCapabilities: readonly string[] };

const AGENT_PROFILE_ROOT = "agent profile";

const AGENT_PROFILE_KEYS: ReadonlySet<string> = new Set([
  "id",
  "adapterId",
  "model",
  "capabilities",
]);

export function normalizeAgentCapability(capability: string): string {
  return capability.trim().toLowerCase();
}

export function evaluateAgentProfileEligibility(
  profile: AgentProfile,
  requiredCapabilities: readonly string[],
): AgentProfileEligibility {
  const declared = new Set(profile.capabilities.map(normalizeAgentCapability));
  const missing: string[] = [];
  for (const required of requiredCapabilities) {
    const normalized = normalizeAgentCapability(required);
    if (declared.has(normalized) || missing.includes(normalized)) {
      continue;
    }
    missing.push(normalized);
  }
  return missing.length === 0
    ? { eligible: true, missingCapabilities: [] }
    : { eligible: false, missingCapabilities: missing };
}

export function validateAgentProfile(
  input: unknown,
): AgentProfileValidationResult {
  if (!isRecord(input)) {
    return {
      ok: false,
      issues: [
        `${AGENT_PROFILE_ROOT}: must be an object with id, adapterId, model, and capabilities`,
      ],
    };
  }
  const issues: string[] = [];
  rejectUnknownFields(input, AGENT_PROFILE_KEYS, AGENT_PROFILE_ROOT, issues);

  const id = requireNonEmptyString(input, "id", issues);
  const adapterId = requireNonEmptyString(input, "adapterId", issues);
  const model = requireOptionalNonEmptyString(input, "model", issues);
  const capabilities = requireCapabilities(input, issues);

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    value:
      model === undefined
        ? { id: defined(id), adapterId: defined(adapterId), capabilities: defined(capabilities) }
        : {
            id: defined(id),
            adapterId: defined(adapterId),
            model,
            capabilities: defined(capabilities),
          },
  };
}

function requireCapabilities(
  source: Record<string, unknown>,
  issues: string[],
): readonly string[] | undefined {
  const path = fieldPath("capabilities");
  const value = source["capabilities"];
  if (!Array.isArray(value)) {
    issues.push(`${path}: must be an array of capability labels`);
    return undefined;
  }
  const capabilities: string[] = [];
  const seen: Set<string> = new Set();
  let valid = true;
  value.forEach((entry: unknown, index: number) => {
    if (typeof entry !== "string" || normalizeAgentCapability(entry).length === 0) {
      issues.push(`${path}[${index}]: must be a non-empty string`);
      valid = false;
      return;
    }
    const normalized = normalizeAgentCapability(entry);
    if (seen.has(normalized)) {
      issues.push(`${path}: must not contain duplicate capability "${normalized}"`);
      valid = false;
      return;
    }
    seen.add(normalized);
    capabilities.push(normalized);
  });
  return valid ? capabilities : undefined;
}

function rejectUnknownFields(
  source: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  issues: string[],
): void {
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) {
      issues.push(`${path}: unknown field "${key}"`);
    }
  }
}

function requireNonEmptyString(
  source: Record<string, unknown>,
  field: string,
  issues: string[],
): string | undefined {
  const value = source[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push(`${fieldPath(field)}: must be a non-empty string`);
    return undefined;
  }
  return value;
}

function requireOptionalNonEmptyString(
  source: Record<string, unknown>,
  field: string,
  issues: string[],
): string | undefined {
  const value = source[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push(`${fieldPath(field)}: must be a non-empty string`);
    return undefined;
  }
  return value;
}

function fieldPath(field: string): string {
  return `${AGENT_PROFILE_ROOT}.${field}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error(
      "internal agent profile validation error: required field is missing without an issue",
    );
  }
  return value;
}
