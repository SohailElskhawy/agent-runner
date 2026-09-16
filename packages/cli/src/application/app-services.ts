import { createNodeProcessRunner } from "@agentic-dev-runner/platform";
import { createGitManager } from "@agentic-dev-runner/git";
import { createSqliteRunnerStore } from "@agentic-dev-runner/persistence";
import { createVerificationEngine, toVerificationCheckSpecs } from "@agentic-dev-runner/verification";
import type {
  VerificationEngine,
} from "@agentic-dev-runner/verification";
import {
  CodexAdapter,
  OpenCodeAdapter,
  createAgentRegistry,
} from "@agentic-dev-runner/agents";
import type { AgentRegistry, AgentRuntime } from "@agentic-dev-runner/agents";
import {
  createCrashRecovery,
  createSingleTaskOrchestrator,
} from "@agentic-dev-runner/orchestrator";
import type {
  CrashRecovery,
  SingleTaskOrchestrator,
} from "@agentic-dev-runner/orchestrator";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import { createAgentAdapterRegistry } from "./agents/agent-adapter-registry.js";
import type { AgentAdapterRegistry } from "./agents/agent-adapter-registry.js";
import { createRoutedTaskOrchestrator } from "./agents/routed-task-orchestrator.js";
import type { ProjectConfiguration } from "@agentic-dev-runner/core";
import {
  loadStrictProjectConfiguration,
  ProjectConfigurationUnavailableError,
} from "./project-configuration.js";
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
  readonly agents: AgentRegistry;
  readonly adapters: AgentAdapterRegistry;
};

export type AppServicesOverrides = {
  readonly store?: RunnerStore | undefined;
  readonly orchestrator?: SingleTaskOrchestrator | undefined;
  readonly recovery?: CrashRecovery | undefined;
  readonly agent?: AgentRuntime | undefined;
  readonly agentRegistry?: AgentRegistry | undefined;
  readonly agentAdapters?: AgentAdapterRegistry | undefined;
  readonly verification?: VerificationEngine | undefined;
};

export async function createAppServices(
  options: AppServicesOptions,
  overrides: AppServicesOverrides = {},
): Promise<AppServices> {
  // Explicit orchestrator/agent overrides keep lower-level injection paths
  // working; production runs always route through configured agent profiles.
  const routed = overrides.orchestrator === undefined && overrides.agent === undefined;
  const configuration =
    routed || options.verificationChecks === undefined
      ? await loadStrictProjectConfiguration(options.projectRoot)
      : null;
  const verificationChecks =
    options.verificationChecks !== undefined
      ? [...options.verificationChecks]
      : toVerificationCheckSpecs(
          requireConfiguration(configuration).verificationChecks,
        );
  const agentProfiles = routed
    ? requireConfiguration(configuration).agentProfiles
    : [];
  const store = overrides.store ?? createSqliteRunnerStore({
    path: resolveStorePath(options),
  });
  const runner = createNodeProcessRunner();
  const git = createGitManager({ runner });
  const verification = overrides.verification ?? createVerificationEngine({ runner });
  const openCodeAdapter = new OpenCodeAdapter(runner);
  const codexAdapter = new CodexAdapter(runner);
  const agents = overrides.agentRegistry ?? createAgentRegistry([
    openCodeAdapter,
    codexAdapter,
  ]);
  const adapters = overrides.agentAdapters ?? createAgentAdapterRegistry([
    openCodeAdapter,
    codexAdapter,
  ]);
  const orchestratorBaseOptions = {
    store,
    git,
    verification,
    verificationChecks,
    projectRoot: options.projectRoot,
    worktreesDir: resolveWorktreesDir(options),
    agentTimeoutMs: resolveAgentTimeoutMs(options),
  };
  const orchestrator = overrides.orchestrator ?? (overrides.agent !== undefined
    ? createSingleTaskOrchestrator({
        ...orchestratorBaseOptions,
        agent: overrides.agent,
      })
    : createRoutedTaskOrchestrator({
        store,
        agentProfiles,
        agents,
        adapters,
        createAgentBackedOrchestrator: (agent) =>
          createSingleTaskOrchestrator({
            ...orchestratorBaseOptions,
            agent,
          }),
      }));
  const recovery = overrides.recovery ?? createCrashRecovery({
    store,
    git,
    verification,
    verificationChecks,
    projectRoot: options.projectRoot,
    worktreesDir: resolveWorktreesDir(options),
  });
  return { store, orchestrator, recovery, agents, adapters };
}

function requireConfiguration(
  configuration: ProjectConfiguration | null,
): ProjectConfiguration {
  if (configuration === null) {
    throw new ProjectConfigurationUnavailableError(
      "project configuration is required for this run but was not loaded",
    );
  }
  return configuration;
}
