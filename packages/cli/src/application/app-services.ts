import { createNodeProcessRunner } from "@agentic-dev-runner/platform";
import { createGitManager } from "@agentic-dev-runner/git";
import { createSqliteRunnerStore } from "@agentic-dev-runner/persistence";
import { createVerificationEngine } from "@agentic-dev-runner/verification";
import type { VerificationEngine } from "@agentic-dev-runner/verification";
import { OpenCodeAdapter } from "@agentic-dev-runner/agents";
import type { AgentRuntime } from "@agentic-dev-runner/agents";
import { createSingleTaskOrchestrator } from "@agentic-dev-runner/orchestrator";
import type { SingleTaskOrchestrator } from "@agentic-dev-runner/orchestrator";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import {
  resolveAgentTimeoutMs,
  resolveStorePath,
  resolveVerificationChecks,
  resolveWorktreesDir,
  type AppServicesOptions,
} from "./defaults.js";

export type AppServices = {
  readonly store: RunnerStore;
  readonly orchestrator: SingleTaskOrchestrator;
};

export type AppServicesOverrides = {
  readonly store?: RunnerStore | undefined;
  readonly orchestrator?: SingleTaskOrchestrator | undefined;
  readonly agent?: AgentRuntime | undefined;
  readonly verification?: VerificationEngine | undefined;
};

export function createAppServices(
  options: AppServicesOptions,
  overrides: AppServicesOverrides = {},
): AppServices {
  const store = overrides.store ?? createSqliteRunnerStore({
    path: resolveStorePath(options),
  });
  const runner = createNodeProcessRunner();
  const orchestrator = overrides.orchestrator ?? createSingleTaskOrchestrator({
    store,
    git: createGitManager({ runner }),
    agent: overrides.agent ?? new OpenCodeAdapter(runner),
    verification: overrides.verification ?? createVerificationEngine({ runner }),
    verificationChecks: resolveVerificationChecks(options),
    projectRoot: options.projectRoot,
    worktreesDir: resolveWorktreesDir(options),
    agentTimeoutMs: resolveAgentTimeoutMs(options),
  });
  return { store, orchestrator };
}
