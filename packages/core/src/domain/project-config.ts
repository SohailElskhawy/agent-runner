import type { AgentProfile } from "./agent-profile.js";
import { validateAgentProfile } from "./agent-profile.js";

export type VerificationCheckDefinition = {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
};

export type ProjectConfiguration = {
  readonly verificationChecks: readonly VerificationCheckDefinition[];
  readonly agentProfiles: readonly AgentProfile[];
};

export type ProjectConfigurationValidationResult =
  | { readonly ok: true; readonly value: ProjectConfiguration }
  | { readonly ok: false; readonly issues: readonly string[] };

const PROJECT_CONFIG_ROOT = "project configuration";

const PROJECT_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "verification",
  "agents",
]);

const VERIFICATION_SECTION_KEYS: ReadonlySet<string> = new Set(["checks"]);

const CHECK_KEYS: ReadonlySet<string> = new Set(["command", "args"]);

const AGENTS_SECTION_KEYS: ReadonlySet<string> = new Set(["profiles"]);

export function validateProjectConfiguration(
  input: unknown,
): ProjectConfigurationValidationResult {
  if (!isRecord(input)) {
    return {
      ok: false,
      issues: [`${PROJECT_CONFIG_ROOT}: must be an object with a verification section`],
    };
  }
  const issues: string[] = [];
  rejectUnknownFields(input, PROJECT_CONFIG_KEYS, PROJECT_CONFIG_ROOT, issues);
  const verification = requireVerificationSection(input, issues);
  const agentProfiles = requireAgentProfiles(input, issues);
  if (
    verification === undefined ||
    agentProfiles === undefined ||
    issues.length > 0
  ) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    value: {
      verificationChecks: defined(verification),
      agentProfiles: defined(agentProfiles),
    },
  };
}

function requireVerificationSection(
  source: Record<string, unknown>,
  issues: string[],
): readonly VerificationCheckDefinition[] | undefined {
  const parentPath = fieldPath("verification");
  const value = source["verification"];
  if (!isRecord(value)) {
    issues.push(`${parentPath}: must be an object with named checks`);
    return undefined;
  }
  rejectUnknownFields(value, VERIFICATION_SECTION_KEYS, parentPath, issues);
  return requireChecks(value, issues);
}

function requireAgentProfiles(
  source: Record<string, unknown>,
  issues: string[],
): readonly AgentProfile[] | undefined {
  const parentPath = fieldPath("agents");
  const agents = source["agents"];
  if (agents === undefined) {
    return [];
  }
  if (!isRecord(agents)) {
    issues.push(`${parentPath}: must be an object with named agent profiles`);
    return undefined;
  }
  rejectUnknownFields(agents, AGENTS_SECTION_KEYS, parentPath, issues);
  const profilesPath = `${parentPath}.profiles`;
  const profiles = agents["profiles"];
  if (!isRecord(profiles)) {
    issues.push(
      `${profilesPath}: must be an object mapping profile ids to profiles`,
    );
    return undefined;
  }
  const agentProfiles: AgentProfile[] = [];
  let valid = true;
  for (const profileId of Object.keys(profiles)) {
    if (!isNonEmptyString(profileId)) {
      issues.push(
        `${profilesPath}."${String(profileId)}": must be a non-empty string profile id`,
      );
      valid = false;
      continue;
    }
    const profilePath = `${profilesPath}.${profileId}`;
    const declaration = profiles[profileId];
    if (!isRecord(declaration)) {
      issues.push(
        `${profilePath}: must be an object with adapter and capabilities`,
      );
      valid = false;
      continue;
    }
    const candidate = toAgentProfileCandidate(profileId, declaration);
    const validated = validateAgentProfile(candidate);
    if (!validated.ok) {
      for (const issue of validated.issues) {
        issues.push(`${profilePath}: ${issue}`);
      }
      valid = false;
      continue;
    }
    agentProfiles.push(validated.value);
  }
  return valid ? agentProfiles : undefined;
}

function toAgentProfileCandidate(
  profileId: string,
  declaration: Record<string, unknown>,
): Record<string, unknown> {
  const candidate: Record<string, unknown> = { ...declaration };
  delete candidate["adapter"];
  candidate["id"] = profileId;
  candidate["adapterId"] = declaration["adapter"];
  return candidate;
}

function requireChecks(
  source: Record<string, unknown>,
  issues: string[],
): readonly VerificationCheckDefinition[] | undefined {
  const path = `${fieldPath("verification")}.checks`;
  const value = source["checks"];
  if (!isRecord(value)) {
    issues.push(`${path}: must be an object mapping check names to checks`);
    return undefined;
  }
  const checks: VerificationCheckDefinition[] = [];
  let valid = true;
  for (const name of Object.keys(value)) {
    if (!isNonEmptyString(name)) {
      issues.push(`${path}.${String(name)}: must be a non-empty string name`);
      valid = false;
      continue;
    }
    const check = requireCheck(value, name, path, issues);
    if (check === undefined) {
      valid = false;
      continue;
    }
    checks.push(check);
  }
  if (checks.length === 0) {
    issues.push(`${path}: must contain at least one check`);
    valid = false;
  }
  return valid ? checks : undefined;
}

function requireCheck(
  source: Record<string, unknown>,
  name: string,
  checksPath: string,
  issues: string[],
): VerificationCheckDefinition | undefined {
  const path = `${checksPath}.${name}`;
  const value = source[name];
  if (!isRecord(value)) {
    issues.push(`${path}: must be an object with command and args`);
    return undefined;
  }
  rejectUnknownFields(value, CHECK_KEYS, path, issues);
  const command = requireCommand(value, path, issues);
  const args = requireArgs(value, path, issues);
  if (command === undefined || args === undefined) {
    return undefined;
  }
  return { name, command, args };
}

function requireCommand(
  source: Record<string, unknown>,
  path: string,
  issues: string[],
): string | undefined {
  const value = source["command"];
  if (!isNonEmptyString(value)) {
    issues.push(`${path}.command: must be a non-empty string`);
    return undefined;
  }
  return value;
}

function requireArgs(
  source: Record<string, unknown>,
  path: string,
  issues: string[],
): readonly string[] | undefined {
  const argPath = `${path}.args`;
  const value = source["args"];
  if (!Array.isArray(value)) {
    issues.push(`${argPath}: must be an array of strings`);
    return undefined;
  }
  const args: string[] = [];
  let valid = true;
  value.forEach((entry: unknown, index: number) => {
    if (typeof entry !== "string") {
      issues.push(`${argPath}[${index}]: must be a string`);
      valid = false;
      return;
    }
    args.push(entry);
  });
  return valid ? args : undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function fieldPath(field: string): string {
  return `${PROJECT_CONFIG_ROOT}.${field}`;
}

function defined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error(
      "internal project configuration validation error: required field is missing without an issue",
    );
  }
  return value;
}
