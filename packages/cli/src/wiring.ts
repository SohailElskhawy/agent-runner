import { createAppServices } from "./application/app-services.js";
import { createStoreBackedAppService } from "./application/store-backed-app-service.js";
import {
  defaultStateDir,
  resolveStorePath,
} from "./application/defaults.js";
import type { RunnerAppService } from "./application/runner-app-service.js";

export function createServices(
  projectRoot?: string,
): Promise<RunnerAppService> {
  const root = projectRoot ?? process.cwd();
  const stateDir = defaultStateDir(root);
  const appServices = createAppServices({
    projectRoot: root,
    stateDir,
  });
  const service = createStoreBackedAppService({
    storePath: resolveStorePath({ projectRoot: root, stateDir }),
    projectRoot: root,
    store: appServices.store,
    orchestrator: appServices.orchestrator,
  });
  return Promise.resolve(service);
}
