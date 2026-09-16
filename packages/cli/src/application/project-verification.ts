import { toVerificationCheckSpecs } from "@agentic-dev-runner/verification";
import type { VerificationCheckSpec } from "@agentic-dev-runner/verification";
import { loadStrictProjectConfiguration } from "./project-configuration.js";

export { ProjectConfigurationUnavailableError } from "./project-configuration.js";

export async function loadProjectVerificationChecks(
  projectRoot: string,
): Promise<VerificationCheckSpec[]> {
  const configuration = await loadStrictProjectConfiguration(projectRoot);
  return toVerificationCheckSpecs(configuration.verificationChecks);
}
