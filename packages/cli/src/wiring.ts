import { createAppServices } from "./application/app-services.js";
import { createStoreBackedAppService } from "./application/store-backed-app-service.js";
import {
  defaultStateDir,
  resolveProjectRoot,
  resolveStorePath,
  resolveWorktreesDir,
  type AppServicesRequest,
} from "./application/defaults.js";
import type { RunnerAppService } from "./application/runner-app-service.js";

export async function createServices(
  projectRoot?: string,
  request: AppServicesRequest = {},
): Promise<RunnerAppService> {
  const root = resolveProjectRoot(projectRoot ?? process.cwd());
  const stateDir = defaultStateDir(root);
  const appServices = await createAppServices(
    {
      projectRoot: root,
      stateDir,
    },
    {},
    request,
  );
  const service = createStoreBackedAppService({
    storePath: resolveStorePath({ projectRoot: root, stateDir }),
    projectRoot: root,
    store: appServices.store,
    orchestrator: appServices.orchestrator,
    recovery: appServices.recovery,
    executionClaimRecovery: appServices.executionClaimRecovery,
    integrationRecovery: appServices.integrationRecovery,
    worktreeRecovery: appServices.worktreeRecovery,
    agents: appServices.agents,
    scheduler: appServices.scheduler,
    maxParallelism: appServices.maxParallelism,
    runner: appServices.runner,
    worktreesDir: resolveWorktreesDir({ projectRoot: root, stateDir }),
    configuration: appServices.configuration,
    configurationError: appServices.configurationError,
  });
  return Promise.resolve(service);
}
