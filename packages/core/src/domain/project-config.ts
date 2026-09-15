export type VerificationCheckDefinition = {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
};

export type ProjectConfiguration = {
  readonly verificationChecks: readonly VerificationCheckDefinition[];
};

export type ProjectConfigurationValidationResult =
  | { readonly ok: true; readonly value: ProjectConfiguration }
  | { readonly ok: false; readonly issues: readonly string[] };

const PROJECT_CONFIG_ROOT = "project configuration";

const PROJECT_CONFIG_KEYS: ReadonlySet<string> = new Set(["verification"]);

const VERIFICATION_SECTION_KEYS: ReadonlySet<string> = new Set(["checks"]);

const CHECK_KEYS: ReadonlySet<string> = new Set(["command", "args"]);

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
  if (verification === undefined || issues.length > 0) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    value: { verificationChecks: defined(verification) },
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
