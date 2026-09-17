import type { TaskScope } from "@agentic-dev-runner/core";

export type TaskScopeViolationKind = "forbidden" | "not-allowed";

export type TaskScopeViolation = {
  readonly path: string;
  readonly kind: TaskScopeViolationKind;
  readonly pattern?: string | undefined;
};

export type TaskScopeValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: readonly TaskScopeViolation[] };

export function normalizeScopePath(path: string): string {
  let normalized = path.replaceAll("\\", "/");
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  if (normalized.startsWith("/")) {
    normalized = normalized.slice(1);
  }
  return normalized;
}

export function matchesScopePattern(path: string, pattern: string): boolean {
  const normalizedPath = normalizeScopePath(path);
  const regexp = compileScopePattern(pattern);
  if (regexp === undefined) {
    return false;
  }
  return pathMatchesRegexp(normalizedPath, regexp);
}

export function validateTaskScope(
  changedPaths: readonly string[],
  scope: TaskScope,
): TaskScopeValidationResult {
  const violations: TaskScopeViolation[] = [];
  const seen = new Set<string>();
  for (const changedPath of changedPaths) {
    const path = normalizeScopePath(changedPath);
    if (path.length === 0 || seen.has(path)) {
      continue;
    }
    seen.add(path);
    const forbiddenPattern = firstMatchingPattern(path, scope.forbiddenPaths);
    if (forbiddenPattern !== undefined) {
      violations.push({ path, kind: "forbidden", pattern: forbiddenPattern });
      continue;
    }
    const allowedPattern = firstMatchingPattern(path, scope.allowedPaths);
    if (allowedPattern === undefined) {
      violations.push({ path, kind: "not-allowed" });
    }
  }
  violations.sort((left, right) => compareStrings(left.path, right.path));
  if (violations.length > 0) {
    return { ok: false, violations };
  }
  return { ok: true };
}

export function describeTaskScopeViolations(
  violations: readonly TaskScopeViolation[],
): string {
  return violations
    .map((violation) => describeViolation(violation))
    .join("; ");
}

function describeViolation(violation: TaskScopeViolation): string {
  if (violation.kind === "forbidden") {
    return `${violation.path} (forbidden by "${violation.pattern}")`;
  }
  return `${violation.path} (no allowed path pattern matched)`;
}

function firstMatchingPattern(
  path: string,
  patterns: readonly string[],
): string | undefined {
  for (const pattern of patterns) {
    const regexp = compileScopePattern(pattern);
    if (regexp !== undefined && pathMatchesRegexp(path, regexp)) {
      return pattern;
    }
  }
  return undefined;
}

const DIRECTORY_PROBE_SUFFIX = "probe-file";

function pathMatchesRegexp(path: string, regexp: RegExp): boolean {
  if (path.endsWith("/")) {
    return regexp.test(`${path}${DIRECTORY_PROBE_SUFFIX}`);
  }
  return regexp.test(path);
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

const REGEX_SPECIAL_CHARS = /[.+^$|(){}[\]\\]/;

function compileScopePattern(rawPattern: string): RegExp | undefined {
  let pattern = rawPattern.replaceAll("\\", "/").trim();
  while (pattern.startsWith("./")) {
    pattern = pattern.slice(2);
  }
  while (pattern.startsWith("/")) {
    pattern = pattern.slice(1);
  }
  const directoryAnchored = pattern.endsWith("/");
  while (pattern.endsWith("/")) {
    pattern = pattern.slice(0, -1);
  }
  if (pattern.length === 0) {
    return undefined;
  }
  if (!pattern.includes("/")) {
    pattern = `**/${pattern}`;
  }
  const source = globSource(pattern);
  if (directoryAnchored && !source.endsWith(".*")) {
    return new RegExp(`^${source}/.+$`);
  }
  return new RegExp(`^${source}$`);
}

function globSource(pattern: string): string {
  let source = "";
  let index = 0;
  while (index < pattern.length) {
    const char = pattern.charAt(index);
    if (char === "*") {
      let starCount = 0;
      while (pattern.charAt(index + starCount) === "*") {
        starCount += 1;
      }
      index += starCount;
      if (starCount === 1) {
        source += "[^/]*";
        continue;
      }
      const atSegmentStart = source.length === 0 || source.endsWith("/");
      const nextChar = pattern.charAt(index);
      if (atSegmentStart && nextChar === "") {
        source += ".*";
        continue;
      }
      if (atSegmentStart && nextChar === "/") {
        source += "(?:[^/]+/)*";
        index += 1;
        continue;
      }
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }
    source += REGEX_SPECIAL_CHARS.test(char) ? `\\${char}` : char;
    index += 1;
  }
  return source;
}