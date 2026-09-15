import type { IsoTimestamp } from "./timestamp.js";
import type { ProjectId, TaskId } from "./ids.js";
import {
  PROVENANCE_KINDS,
  TASK_COMPLEXITIES,
  TASK_RISKS,
  TASK_TYPES,
  type Provenance,
  type TaskApproval,
  type TaskDefinition,
  type TaskLimits,
  type TaskPriority,
  type TaskRisk,
  type TaskRouting,
  type TaskScope,
  type TaskType,
  type TaskVerificationRequirement,
} from "./task-contract.js";
import type { Task } from "./task.js";

const MANUAL_TASK_INITIAL_STATUSES = [
  "BACKLOG",
  "READY",
] as const;

export type ManualTaskInitialStatus = (typeof MANUAL_TASK_INITIAL_STATUSES)[number];

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const TASK_PRIORITY_PATTERN = /^P\d+$/;

function isValidTaskIdSyntax(value: unknown): value is TaskId {
  return typeof value === "string" && TASK_ID_PATTERN.test(value);
}

export type ManualTaskInput = {
  readonly id: TaskId;
  readonly title: string;
  readonly milestone: string;
  readonly status: ManualTaskInitialStatus;
  readonly priority: TaskPriority;
  readonly risk: TaskRisk;
  readonly type: TaskType;
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly dependsOn: readonly TaskId[];
  readonly provenance: Provenance;
  readonly scope: TaskScope;
  readonly resources: readonly string[];
  readonly workflow: string;
  readonly routing: TaskRouting;
  readonly verification: TaskVerificationRequirement;
  readonly limits: TaskLimits;
  readonly approval: TaskApproval;
};

export type ManualTaskValidationResult =
  | { readonly ok: true; readonly value: ManualTaskInput }
  | { readonly ok: false; readonly issues: readonly string[] };

const MANUAL_TASK_INPUT_KEYS: ReadonlySet<string> = new Set([
  "id",
  "title",
  "milestone",
  "status",
  "priority",
  "risk",
  "type",
  "objective",
  "acceptanceCriteria",
  "dependsOn",
  "provenance",
  "scope",
  "resources",
  "workflow",
  "routing",
  "verification",
  "limits",
  "approval",
]);

const PROVENANCE_KEYS: ReadonlySet<string> = new Set(["kind", "source"]);

const SCOPE_KEYS: ReadonlySet<string> = new Set([
  "allowedPaths",
  "forbiddenPaths",
]);

const ROUTING_KEYS: ReadonlySet<string> = new Set([
  "complexity",
  "capabilities",
]);

const VERIFICATION_KEYS: ReadonlySet<string> = new Set(["required"]);

const LIMITS_KEYS: ReadonlySet<string> = new Set([
  "maxAttempts",
  "maxReviewCycles",
]);

const APPROVAL_KEYS: ReadonlySet<string> = new Set(["required", "reason"]);

const TASK_DEFINITION_ROOT = "task definition";

export function validateManualTaskInput(
  input: unknown,
): ManualTaskValidationResult {
  const issues: string[] = [];
  if (!isRecord(input)) {
    return {
      ok: false,
      issues: [`${TASK_DEFINITION_ROOT}: must be a JSON object`],
    };
  }

  rejectUnknownFields(input, MANUAL_TASK_INPUT_KEYS, TASK_DEFINITION_ROOT, issues);

  const id = requireNonEmptyString(input, "id", issues);
  const title = requireNonEmptyString(input, "title", issues);
  const milestone = requireNonEmptyString(input, "milestone", issues);
  const objective = requireNonEmptyString(input, "objective", issues);
  const workflow = requireNonEmptyString(input, "workflow", issues);

  const status = requireOneOf(
    input,
    "status",
    MANUAL_TASK_INITIAL_STATUSES,
    issues,
    "must be one of BACKLOG or READY for a manually added task",
  );
  const priority = requirePriority(input, issues);
  const risk = requireOneOf(input, "risk", TASK_RISKS, issues);
  const type = requireOneOf(input, "type", TASK_TYPES, issues);

  const acceptanceCriteria = requireStringList(input, "acceptanceCriteria", issues);
  if (acceptanceCriteria !== undefined && acceptanceCriteria.length === 0) {
    issues.push(
      `${fieldPath("acceptanceCriteria")}: must contain at least one criterion`,
    );
  }

  const dependsOn = requireDependencyList(input, issues);
  const resources = requireStringList(input, "resources", issues);

  const provenance = requireProvenance(input, issues);
  const scope = requireScope(input, issues);
  const routing = requireRouting(input, issues);
  const verification = requireVerification(input, issues);
  const limits = requireLimits(input, issues);
  const approval = requireApproval(input, issues);

  if (id !== undefined && !TASK_ID_PATTERN.test(id)) {
    issues.push(
      `${fieldPath("id")}: must be a syntactically valid task ID matching ${TASK_ID_PATTERN.source}`,
    );
  }

  if (id !== undefined && dependsOn !== undefined && dependsOn.includes(id)) {
    issues.push(
      `${fieldPath("dependsOn")}: must not reference the task itself ("${id}")`,
    );
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    value: {
      id: defined(id),
      title: defined(title),
      milestone: defined(milestone),
      status: defined(status),
      priority: defined(priority),
      risk: defined(risk),
      type: defined(type),
      objective: defined(objective),
      acceptanceCriteria: defined(acceptanceCriteria),
      dependsOn: defined(dependsOn),
      provenance: defined(provenance),
      scope: defined(scope),
      resources: defined(resources),
      workflow: defined(workflow),
      routing: defined(routing),
      verification: defined(verification),
      limits: defined(limits),
      approval: defined(approval),
    },
  };
}

export function buildTaskFromManualInput(
  input: ManualTaskInput,
  context: {
    readonly projectId: ProjectId;
    readonly now: IsoTimestamp;
  },
): Task {
  const definition: TaskDefinition = {
    objective: input.objective,
    acceptanceCriteria: input.acceptanceCriteria,
    scope: input.scope,
    resources: input.resources,
    verification: input.verification,
    limits: input.limits,
    approval: input.approval,
  };
  return {
    id: input.id,
    projectId: context.projectId,
    title: input.title,
    milestone: input.milestone,
    status: input.status,
    type: input.type,
    priority: input.priority,
    risk: input.risk,
    definition,
    routing: input.routing,
    provenance: input.provenance,
    dependsOn: input.dependsOn,
    workflow: input.workflow,
    createdAt: context.now,
    updatedAt: context.now,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldPath(field: string): string {
  return `${TASK_DEFINITION_ROOT}.${field}`;
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

function requireOneOf<T extends string>(
  source: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  issues: string[],
  message?: string,
): T | undefined {
  const value = source[field];
  if (!isOneOf(value, allowed)) {
    issues.push(
      `${fieldPath(field)}: ${message ?? `must be one of: ${allowed.join(", ")}`}`,
    );
    return undefined;
  }
  return value;
}

function isOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return (
    typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
  );
}

function requirePriority(
  source: Record<string, unknown>,
  issues: string[],
): TaskPriority | undefined {
  const value = source["priority"];
  if (!isTaskPrioritySyntax(value)) {
    issues.push(
      `${fieldPath("priority")}: must match "P<number>" (e.g. "P0", "P1")`,
    );
    return undefined;
  }
  return value;
}

function isTaskPrioritySyntax(value: unknown): value is TaskPriority {
  return typeof value === "string" && TASK_PRIORITY_PATTERN.test(value);
}

function requireStringList(
  source: Record<string, unknown>,
  field: string,
  issues: string[],
): readonly string[] | undefined {
  const path = fieldPath(field);
  const value = source[field];
  if (!Array.isArray(value)) {
    issues.push(`${path}: must be an array of strings`);
    return undefined;
  }
  const entries: string[] = [];
  let valid = true;
  value.forEach((entry: unknown, index: number) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      issues.push(`${path}[${index}]: must be a non-empty string`);
      valid = false;
      return;
    }
    entries.push(entry);
  });
  return valid ? entries : undefined;
}

function requireDependencyList(
  source: Record<string, unknown>,
  issues: string[],
): readonly TaskId[] | undefined {
  const path = fieldPath("dependsOn");
  const value = source["dependsOn"];
  if (!Array.isArray(value)) {
    issues.push(`${path}: must be an array of task IDs`);
    return undefined;
  }
  const ids: TaskId[] = [];
  const seen: Set<string> = new Set();
  let valid = true;
  value.forEach((entry: unknown, index: number) => {
    if (!isValidTaskIdSyntax(entry)) {
      issues.push(
        `${path}[${index}]: must be a syntactically valid task ID matching ${TASK_ID_PATTERN.source}`,
      );
      valid = false;
      return;
    }
    if (seen.has(entry)) {
      issues.push(
        `${path}: must not contain duplicate dependency "${entry}"`,
      );
      valid = false;
      return;
    }
    seen.add(entry);
    ids.push(entry);
  });
  return valid ? ids : undefined;
}

function requireProvenance(
  source: Record<string, unknown>,
  issues: string[],
): Provenance | undefined {
  const parentPath = fieldPath("provenance");
  const value = source["provenance"];
  if (!isRecord(value)) {
    issues.push(`${parentPath}: must be an object with kind and source`);
    return undefined;
  }
  rejectUnknownFields(value, PROVENANCE_KEYS, parentPath, issues);
  const kind = requireNestedOneOf(value, "kind", PROVENANCE_KINDS, parentPath, issues);
  const provenanceSource = requireNestedNonEmptyString(
    value,
    "source",
    parentPath,
    issues,
  );
  if (kind === undefined || provenanceSource === undefined) {
    return undefined;
  }
  return { kind, source: provenanceSource };
}

function requireScope(
  source: Record<string, unknown>,
  issues: string[],
): TaskScope | undefined {
  const parentPath = fieldPath("scope");
  const value = source["scope"];
  if (!isRecord(value)) {
    issues.push(`${parentPath}: must be an object with allowedPaths and forbiddenPaths`);
    return undefined;
  }
  rejectUnknownFields(value, SCOPE_KEYS, parentPath, issues);
  const allowedPaths = requireScopePathList(
    value,
    "allowedPaths",
    parentPath,
    issues,
  );
  const forbiddenPaths = requireScopePathList(
    value,
    "forbiddenPaths",
    parentPath,
    issues,
  );
  if (allowedPaths === undefined || forbiddenPaths === undefined) {
    return undefined;
  }
  return { allowedPaths, forbiddenPaths };
}

function requireScopePathList(
  source: Record<string, unknown>,
  field: string,
  parentPath: string,
  issues: string[],
): readonly string[] | undefined {
  const path = `${parentPath}.${field}`;
  const value = source[field];
  if (!Array.isArray(value)) {
    issues.push(`${path}: must be an array of path patterns`);
    return undefined;
  }
  const paths: string[] = [];
  let valid = true;
  value.forEach((entry: unknown, index: number) => {
    if (!isValidScopePathPattern(entry)) {
      issues.push(
        `${path}[${index}]: must be a relative path pattern using "/" separators (e.g. "src/**")`,
      );
      valid = false;
      return;
    }
    paths.push(entry);
  });
  return valid ? paths : undefined;
}

function isValidScopePathPattern(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !value.includes("\\") &&
    !value.includes("\u0000") &&
    !isAbsoluteScopePathPattern(value)
  );
}

function isAbsoluteScopePathPattern(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/.test(value)
  );
}

function requireRouting(
  source: Record<string, unknown>,
  issues: string[],
): TaskRouting | undefined {
  const parentPath = fieldPath("routing");
  const value = source["routing"];
  if (!isRecord(value)) {
    issues.push(`${parentPath}: must be an object with complexity and capabilities`);
    return undefined;
  }
  rejectUnknownFields(value, ROUTING_KEYS, parentPath, issues);
  const complexity = requireNestedOneOf(
    value,
    "complexity",
    TASK_COMPLEXITIES,
    parentPath,
    issues,
  );
  const capabilities = requireNestedStringList(
    value,
    "capabilities",
    parentPath,
    issues,
  );
  if (complexity === undefined || capabilities === undefined) {
    return undefined;
  }
  return { complexity, capabilities };
}

function requireVerification(
  source: Record<string, unknown>,
  issues: string[],
): TaskVerificationRequirement | undefined {
  const parentPath = fieldPath("verification");
  const value = source["verification"];
  if (!isRecord(value)) {
    issues.push(`${parentPath}: must be an object with a required list`);
    return undefined;
  }
  rejectUnknownFields(value, VERIFICATION_KEYS, parentPath, issues);
  const required = requireNestedStringList(value, "required", parentPath, issues);
  if (required === undefined) {
    return undefined;
  }
  return { required };
}

function requireLimits(
  source: Record<string, unknown>,
  issues: string[],
): TaskLimits | undefined {
  const parentPath = fieldPath("limits");
  const value = source["limits"];
  if (!isRecord(value)) {
    issues.push(
      `${parentPath}: must be an object with maxAttempts and maxReviewCycles`,
    );
    return undefined;
  }
  rejectUnknownFields(value, LIMITS_KEYS, parentPath, issues);
  const maxAttempts = requireNestedPositiveInteger(
    value,
    "maxAttempts",
    parentPath,
    issues,
  );
  const maxReviewCycles = requireNestedPositiveInteger(
    value,
    "maxReviewCycles",
    parentPath,
    issues,
  );
  if (maxAttempts === undefined || maxReviewCycles === undefined) {
    return undefined;
  }
  return { maxAttempts, maxReviewCycles };
}

function requireApproval(
  source: Record<string, unknown>,
  issues: string[],
): TaskApproval | undefined {
  const parentPath = fieldPath("approval");
  const value = source["approval"];
  if (!isRecord(value)) {
    issues.push(`${parentPath}: must be an object with a required flag`);
    return undefined;
  }
  rejectUnknownFields(value, APPROVAL_KEYS, parentPath, issues);
  if (typeof value["required"] !== "boolean") {
    issues.push(`${parentPath}.required: must be a boolean`);
    return undefined;
  }
  const reason = value["reason"];
  if (reason !== undefined) {
    if (typeof reason !== "string" || reason.trim().length === 0) {
      issues.push(`${parentPath}.reason: must be a non-empty string`);
      return undefined;
    }
    return { required: value["required"], reason };
  }
  return { required: value["required"] };
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

function requireNestedNonEmptyString(
  source: Record<string, unknown>,
  field: string,
  parentPath: string,
  issues: string[],
): string | undefined {
  const value = source[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push(`${parentPath}.${field}: must be a non-empty string`);
    return undefined;
  }
  return value;
}

function requireNestedOneOf<T extends string>(
  source: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  parentPath: string,
  issues: string[],
): T | undefined {
  const value = source[field];
  if (!isOneOf(value, allowed)) {
    issues.push(`${parentPath}.${field}: must be one of: ${allowed.join(", ")}`);
    return undefined;
  }
  return value;
}

function requireNestedStringList(
  source: Record<string, unknown>,
  field: string,
  parentPath: string,
  issues: string[],
): readonly string[] | undefined {
  const path = `${parentPath}.${field}`;
  const value = source[field];
  if (!Array.isArray(value)) {
    issues.push(`${path}: must be an array of strings`);
    return undefined;
  }
  const entries: string[] = [];
  let valid = true;
  value.forEach((entry: unknown, index: number) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      issues.push(`${path}[${index}]: must be a non-empty string`);
      valid = false;
      return;
    }
    entries.push(entry);
  });
  return valid ? entries : undefined;
}

function requireNestedPositiveInteger(
  source: Record<string, unknown>,
  field: string,
  parentPath: string,
  issues: string[],
): number | undefined {
  const path = `${parentPath}.${field}`;
  const value = source[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    issues.push(`${path}: must be a positive integer`);
    return undefined;
  }
  return value;
}

function defined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error(
      "internal task validation error: required field is missing without an issue",
    );
  }
  return value;
}
