import { readFileSync } from "node:fs";
import { CliError } from "../errors.js";
import { describeError } from "../io.js";

export function readTaskFile(filePath: string): unknown {
  const content = readTaskFileContent(filePath);
  const parsed = parseTaskFileJson(content, filePath);
  return normalizeExternalTaskDefinition(parsed, filePath);
}

function readTaskFileContent(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    if (isErrnoException(error)) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") {
        throw new CliError(`task file "${filePath}" does not exist`);
      }
      if (error.code === "EISDIR") {
        throw new CliError(`task file "${filePath}" is a directory, not a file`);
      }
    }
    throw new CliError(
      `cannot read task file "${filePath}": ${describeError(error)}`,
    );
  }
}

function parseTaskFileJson(content: string, filePath: string): unknown {
  try {
    return JSON.parse(stripUtf8Bom(content)) as unknown;
  } catch (error) {
    throw new CliError(
      `task file "${filePath}" is not valid JSON: ${describeError(error)}`,
    );
  }
}

const EXTERNAL_TASK_KEYS: ReadonlySet<string> = new Set([
  "id",
  "title",
  "milestone",
  "status",
  "priority",
  "risk",
  "type",
  "objective",
  "acceptance_criteria",
  "depends_on",
  "provenance",
  "scope",
  "resources",
  "workflow",
  "routing",
  "verification",
  "limits",
  "approval",
]);

const EXTERNAL_SCOPE_KEYS: ReadonlySet<string> = new Set([
  "allowed_paths",
  "forbidden_paths",
]);

const EXTERNAL_LIMITS_KEYS: ReadonlySet<string> = new Set([
  "max_attempts",
  "max_review_cycles",
]);

const EXTERNAL_TASK_STATUSES: ReadonlyMap<string, string> = new Map([
  ["backlog", "BACKLOG"],
  ["ready", "READY"],
]);

function normalizeExternalTaskDefinition(
  raw: unknown,
  filePath: string,
): unknown {
  if (!isRecord(raw)) {
    return raw;
  }
  for (const key of Object.keys(raw)) {
    if (!EXTERNAL_TASK_KEYS.has(key)) {
      throw new CliError(`task file "${filePath}" unknown field "${key}"`);
    }
  }
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case "acceptance_criteria":
        normalized["acceptanceCriteria"] = value;
        break;
      case "depends_on":
        normalized["dependsOn"] = value;
        break;
      case "status":
        normalized["status"] = normalizeExternalStatus(value, filePath);
        break;
      case "scope":
        normalized["scope"] = normalizeExternalScope(value, filePath);
        break;
      case "limits":
        normalized["limits"] = normalizeExternalLimits(value, filePath);
        break;
      default:
        normalized[key] = value;
    }
  }
  return normalized;
}

function normalizeExternalStatus(value: unknown, filePath: string): string {
  const normalized =
    typeof value === "string" ? EXTERNAL_TASK_STATUSES.get(value) : undefined;
  if (normalized === undefined) {
    throw new CliError(
      `task file "${filePath}" status: must be one of backlog or ready`,
    );
  }
  return normalized;
}

function normalizeExternalScope(value: unknown, filePath: string): unknown {
  if (!isRecord(value)) {
    return value;
  }
  for (const key of Object.keys(value)) {
    if (!EXTERNAL_SCOPE_KEYS.has(key)) {
      throw new CliError(
        `task file "${filePath}" scope: unknown field "${key}"`,
      );
    }
  }
  const normalized: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    switch (entryKey) {
      case "allowed_paths":
        normalized["allowedPaths"] = entryValue;
        break;
      case "forbidden_paths":
        normalized["forbiddenPaths"] = entryValue;
        break;
    }
  }
  return normalized;
}

function normalizeExternalLimits(value: unknown, filePath: string): unknown {
  if (!isRecord(value)) {
    return value;
  }
  for (const key of Object.keys(value)) {
    if (!EXTERNAL_LIMITS_KEYS.has(key)) {
      throw new CliError(
        `task file "${filePath}" limits: unknown field "${key}"`,
      );
    }
  }
  const normalized: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    switch (entryKey) {
      case "max_attempts":
        normalized["maxAttempts"] = entryValue;
        break;
      case "max_review_cycles":
        normalized["maxReviewCycles"] = entryValue;
        break;
    }
  }
  return normalized;
}

function stripUtf8Bom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    typeof (error as NodeJS.ErrnoException).code === "string"
  );
}
