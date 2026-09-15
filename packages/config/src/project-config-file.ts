import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  validateProjectConfiguration,
  type ProjectConfiguration,
} from "@agentic-dev-runner/core";
import { parseProjectConfigYaml } from "./parse-yaml.js";

export const PROJECT_CONFIG_FILE_NAME = "agentic.yaml";

export type ProjectConfigurationResult =
  | { readonly ok: true; readonly config: ProjectConfiguration }
  | { readonly ok: false; readonly reason: "ABSENT" }
  | {
      readonly ok: false;
      readonly reason: "READ_FAILED";
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly reason: "PARSE_FAILED";
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly reason: "INVALID";
      readonly issues: readonly string[];
    };

export async function loadProjectConfiguration(
  projectRoot: string,
): Promise<ProjectConfigurationResult> {
  const configPath = join(projectRoot, PROJECT_CONFIG_FILE_NAME);

  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if (isFileAbsent(error)) {
      return { ok: false, reason: "ABSENT" };
    }
    return { ok: false, reason: "READ_FAILED", message: toMessage(error) };
  }

  const parsed = parseProjectConfigYaml(source);
  if (!parsed.ok) {
    return { ok: false, reason: "PARSE_FAILED", message: parsed.message };
  }

  const validated = validateProjectConfiguration(parsed.value);
  if (!validated.ok) {
    return { ok: false, reason: "INVALID", issues: validated.issues };
  }

  return { ok: true, config: validated.value };
}

function isFileAbsent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
