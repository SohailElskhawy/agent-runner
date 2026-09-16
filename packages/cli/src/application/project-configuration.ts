import { join } from "node:path";
import type { ProjectConfiguration } from "@agentic-dev-runner/core";
import {
  loadProjectConfiguration,
  PROJECT_CONFIG_FILE_NAME,
} from "@agentic-dev-runner/config";
import type { ProjectConfigurationResult } from "@agentic-dev-runner/config";

export class ProjectConfigurationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectConfigurationUnavailableError";
  }
}

export async function loadStrictProjectConfiguration(
  projectRoot: string,
): Promise<ProjectConfiguration> {
  const result = await loadProjectConfiguration(projectRoot);
  if (result.ok) {
    return result.config;
  }
  throw new ProjectConfigurationUnavailableError(
    `project configuration could not be loaded for project root "${projectRoot}": ${describeProjectConfigurationFailure(result)}`,
  );
}

function describeProjectConfigurationFailure(
  result: Exclude<ProjectConfigurationResult, { ok: true }>,
): string {
  const configPath = join(
    "<project root>",
    PROJECT_CONFIG_FILE_NAME,
  );
  switch (result.reason) {
    case "ABSENT":
      return `${PROJECT_CONFIG_FILE_NAME} is missing; define named verification checks in ${configPath}`;
    case "READ_FAILED":
      return `reading ${PROJECT_CONFIG_FILE_NAME} failed: ${result.message}`;
    case "PARSE_FAILED":
      return `parsing ${PROJECT_CONFIG_FILE_NAME} failed: ${result.message}`;
    case "INVALID":
      return `${PROJECT_CONFIG_FILE_NAME} is invalid: ${result.issues.join("; ")}`;
  }
}
