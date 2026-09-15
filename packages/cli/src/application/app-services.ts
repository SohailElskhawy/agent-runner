import { createNodeProcessRunner } from "@agentic-dev-runner/platform";
import { createGitManager } from "@agentic-dev-runner/git";
import { createSqliteRunnerStore } from "@agentic-dev-runner/persistence";
import { createVerificationEngine } from "@agentic-dev-runner/verification";
import type {
  VerificationCheckSpec,
  VerificationEngine,
} from "@agentic-dev-runner/verification";
import { OpenCodeAdapter } from "@agentic-dev-runner/agents";
import type { AgentRuntime } from "@agentic-dev-runner/agents";
import {
  createCrashRecovery,
  createSingleTaskOrchestrator,
} from "@agentic-dev-runner/orchestrator";
import type {
  CrashRecovery,
  SingleTaskOrchestrator,
} from "@agentic-dev-runner/orchestrator";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import { loadProjectVerificationChecks } from "./project-verification.js";
import {
  resolveAgentTimeoutMs,
  resolveStorePath,
  resolveWorktreesDir,
  type AppServicesOptions,
} from "./defaults.js";

export type AppServices = {
  readonly store: RunnerStore;
  readonly orchestrator: SingleTaskOrchestrator;
  readonly recovery: CrashRecovery;
};

export type AppServicesOverrides = {
  readonly store?: RunnerStore | undefined;
  readonly orchestrator?: SingleTaskOrchestrator | undefined;
  readonly recovery?: CrashRecovery | undefined;
  readonly agent?: AgentRuntime | undefined;
  readonly verification?: VerificationEngine | undefined;
};

export async function createAppServices(
  options: AppServicesOptions,
  overrides: AppServicesOverrides = {},
): Promise<AppServices> {
  const verificationChecks = await resolveConfiguredVerificationChecks(options);
  const store = overrides.store ?? createSqliteRunnerStore({
    path: resolveStorePath(options),
  });
  const runner = createNodeProcessRunner();
  const git = createGitManager({ runner });
  const verification = overrides.verification ?? createVerificationEngine({ runner });
  const orchestrator = overrides.orchestrator ?? createSingleTaskOrchestrator({
    store,
    git,
    agent: overrides.agent ?? new OpenCodeAdapter(runner),
    verification,
    verificationChecks,
    projectRoot: options.projectRoot,
    worktreesDir: resolveWorktreesDir(options),
    agentTimeoutMs: resolveAgentTimeoutMs(options),
  });
  const recovery = overrides.recovery ?? createCrashRecovery({
    store,
    git,
    verification,
    verificationChecks,
    projectRoot: options.projectRoot,
    worktreesDir: resolveWorktreesDir(options),
  });
  return { store, orchestrator, recovery };
}

async function resolveConfiguredVerificationChecks(
  options: AppServicesOptions,
): Promise<VerificationCheckSpec[]> {
  if (options.verificationChecks !== undefined) {
    return [...options.verificationChecks];
  }
  return await loadProjectVerificationChecks(options.projectRoot);
}
