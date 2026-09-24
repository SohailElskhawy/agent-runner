import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { validateManualTaskInput } from "@agentic-dev-runner/core";
import { parseProjectConfigYaml } from "@agentic-dev-runner/config";
import { readTaskFile } from "../src/application/task-file.js";

const DOC_PATH = fileURLToPath(
  new URL("../../../docs/TASK_SCHEMA.md", import.meta.url),
);

const YAML_BLOCK_PATTERN = /```yaml\n([\s\S]*?)```/g;

function yamlBlocks(): readonly string[] {
  const source = readFileSync(DOC_PATH, "utf8");
  return [...source.matchAll(YAML_BLOCK_PATTERN)].map(
    (match) => match[1] ?? "",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBlock(block: string): Record<string, unknown> | undefined {
  // The doc examples use the documented task schema; project-config YAML
  // parsing is the only strict YAML parser in the repository.
  const parsed = parseProjectConfigYaml(block);
  expect(parsed.ok, parsed.ok ? "" : parsed.message).toBe(true);
  if (!parsed.ok || !isRecord(parsed.value)) {
    return undefined;
  }
  return parsed.value;
}

function isFullTaskExample(value: Record<string, unknown>): boolean {
  return typeof value["id"] === "string" && typeof value["title"] === "string";
}

function validateThroughIngestion(
  directory: string,
  fileName: string,
  task: Record<string, unknown>,
) {
  const file = join(directory, fileName);
  writeFileSync(file, JSON.stringify(task), "utf8");
  return validateManualTaskInput(readTaskFile(file));
}

describe("TASK_SCHEMA.md examples stay valid", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentic-task-schema-"));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it.each(yamlBlocks().map((block, index) => [index, block] as const))(
    "yaml block %i parses and validates through tasks add ingestion",
    (index, block) => {
      const value = parseBlock(block);
      // Task examples are identified by the presence of an id/title pair.
      if (value === undefined || !isFullTaskExample(value)) {
        return; // fragments like verification/approval snippets are validated below
      }
      const validation = validateThroughIngestion(
        directory,
        `task-${String(index)}.json`,
        value,
      );
      expect(
        validation.ok,
        validation.ok ? "" : validation.issues.join("; "),
      ).toBe(true);
    },
  );
});

// Fragments (for example `verification:` or `approval:` blocks) document task
// sections rather than complete tasks. They are embedded into a minimal valid
// task so the documented fields still travel the real ingestion path: a block
// whose fields the validator rejects as unknown fails here.
const FRAGMENT_HOST_TASK: Readonly<Record<string, unknown>> = {
  id: "M900",
  title: "Host a TASK_SCHEMA.md fragment in a valid task",
  milestone: "documentation",
  status: "ready",
  priority: "P2",
  risk: "low",
  type: "documentation",
  objective: "Validate documented task-schema fragments through task ingestion.",
  acceptance_criteria: ["The documented fragment is accepted by the validator."],
  depends_on: [],
  provenance: { kind: "user_request", source: "task-schema-doc" },
  scope: { allowed_paths: ["docs/**"], forbidden_paths: [] },
  resources: [],
  workflow: "default",
  routing: { complexity: "small", capabilities: ["documentation"] },
  verification: { required: ["typecheck"] },
  limits: { max_attempts: 1, max_review_cycles: 1 },
  approval: { required: false },
};

describe("TASK_SCHEMA.md fragment examples stay valid in task context", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentic-task-schema-fragments-"));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it.each(yamlBlocks().map((block, index) => [index, block] as const))(
    "yaml block %i is accepted when embedded in a valid task",
    (index, block) => {
      const fragment = parseBlock(block);
      if (fragment === undefined || isFullTaskExample(fragment)) {
        return; // full-task examples are covered by the ingestion test above
      }
      const keys = Object.keys(fragment);
      if (
        keys.length === 0 ||
        !keys.every((key) => Object.hasOwn(FRAGMENT_HOST_TASK, key))
      ) {
        return; // e.g. `agent: codex` illustrates a non-v0.1 field, not a section
      }
      const merged: Record<string, unknown> = { ...FRAGMENT_HOST_TASK };
      for (const key of keys) {
        const base = FRAGMENT_HOST_TASK[key];
        const entry = fragment[key];
        merged[key] =
          isRecord(base) && isRecord(entry) ? { ...base, ...entry } : entry;
      }
      const validation = validateThroughIngestion(
        directory,
        `fragment-${String(index)}.json`,
        merged,
      );
      expect(
        validation.ok,
        validation.ok ? "" : validation.issues.join("; "),
      ).toBe(true);
    },
  );
});
