export type RepositoryEvidence =
  | { readonly path: string; readonly status: "present"; readonly content: string }
  | { readonly path: string; readonly status: "absent" };

export type PlanningInput = {
  readonly repositoryRoot: string;
  readonly goal: string;
  readonly baseRevision: string;
  readonly repositoryEvidence: readonly RepositoryEvidence[];
  readonly knownDecisions: readonly string[];
  readonly answeredQuestionIds: readonly string[];
  readonly existingTaskIds: readonly string[];
};

export type PlanningInputValidationResult =
  | { readonly ok: true; readonly value: PlanningInput }
  | { readonly ok: false; readonly issues: readonly string[] };

export function validatePlanningInput(input: unknown): PlanningInputValidationResult {
  const issues: string[] = [];
  if (!isRecord(input)) return { ok: false, issues: ["planning input: must be an object"] };
  const repositoryRoot = requireString(input, "repositoryRoot", issues);
  const goal = requireString(input, "goal", issues);
  const baseRevision = requireString(input, "baseRevision", issues);
  const repositoryEvidence = requireArray(input, "repositoryEvidence", issues, (entry, index) => {
    if (!isRecord(entry) || !isNonEmptyString(entry["path"])) {
      issues.push(`planning input.repositoryEvidence[${index}]: must have a non-empty path`);
      return undefined;
    }
    if (entry["status"] === "absent") return { path: entry["path"], status: "absent" as const };
    if (entry["status"] === "present" && typeof entry["content"] === "string") {
      return { path: entry["path"], status: "present" as const, content: entry["content"] };
    }
    issues.push(`planning input.repositoryEvidence[${index}]: must be present with content or absent`);
    return undefined;
  });
  const knownDecisions = requireArray(input, "knownDecisions", issues, (entry, index) =>
    requireArrayString(entry, `knownDecisions[${index}]`, issues));
  const answeredQuestionIds = requireArray(input, "answeredQuestionIds", issues, (entry, index) =>
    requireArrayString(entry, `answeredQuestionIds[${index}]`, issues));
  const existingTaskIds = requireArray(input, "existingTaskIds", issues, (entry, index) =>
    requireArrayString(entry, `existingTaskIds[${index}]`, issues));
  if (knownDecisions !== undefined && answeredQuestionIds !== undefined && knownDecisions.length !== answeredQuestionIds.length) {
    issues.push("planning input.answeredQuestionIds: must match knownDecisions length");
  }
  if (issues.length || repositoryRoot === undefined || goal === undefined || baseRevision === undefined || repositoryEvidence === undefined || knownDecisions === undefined || answeredQuestionIds === undefined || existingTaskIds === undefined) {
    return { ok: false, issues };
  }
  return { ok: true, value: { repositoryRoot, goal, baseRevision, repositoryEvidence, knownDecisions, answeredQuestionIds, existingTaskIds } };
}

function requireString(source: Record<string, unknown>, key: string, issues: string[]): string | undefined {
  const value = source[key];
  if (!isNonEmptyString(value)) {
    issues.push(`planning input.${key}: must be a non-empty string`);
    return undefined;
  }
  return value;
}

function requireArray<T>(source: Record<string, unknown>, key: string, issues: string[], parse: (value: unknown, index: number) => T | undefined): T[] | undefined {
  const value = source[key];
  if (!Array.isArray(value)) {
    issues.push(`planning input.${key}: must be an array`);
    return undefined;
  }
  const parsed: T[] = [];
  value.forEach((entry: unknown, index: number) => {
    const item = parse(entry, index);
    if (item !== undefined) parsed.push(item);
  });
  return parsed;
}

function requireArrayString(value: unknown, path: string, issues: string[]): string | undefined {
  if (!isNonEmptyString(value)) {
    issues.push(`planning input.${path}: must be a non-empty string`);
    return undefined;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
