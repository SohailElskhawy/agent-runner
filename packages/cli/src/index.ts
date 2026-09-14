export { CliError } from "./errors.js";
export { consoleIo, describeError, type CliIo } from "./io.js";
export { parseArgs, KNOWN_COMMANDS, type ParsedCommand } from "./parse-args.js";
export { runCli, EXIT_USAGE, type RunCliOptions, type CliServicesFactory } from "./run-cli.js";
export { executeInitCommand, executeRunCommand, executeStatusCommand, executeInspectCommand, EXIT_SUCCESS, EXIT_FAILURE } from "./commands/execute-commands.js";
export { createAppServices, type AppServices, type AppServicesOverrides } from "./application/app-services.js";
export { createServices } from "./wiring.js";
export {
  createStoreBackedAppService,
  type StoreBackedAppServiceOptions,
} from "./application/store-backed-app-service.js";
export {
  outcomeToRunResult,
  type RunnerAppService,
} from "./application/runner-app-service.js";
export type {
  InitResult,
  RunResult,
  ProjectStatus,
  TaskStatusEntry,
  LatestAttemptSummary,
  TaskInspection,
  TaskInspectionAttempt,
  TaskInspectionEvent,
} from "./application/ports.js";
export {
  DEFAULT_AGENT_TIMEOUT_MS,
  DEFAULT_PROJECT_ID,
  STATE_DB_FILE_NAME,
  STATE_ROOT_SEGMENT,
  WORKTREES_DIR_NAME,
  projectKey,
  defaultStateDir,
  resolveAgentTimeoutMs,
  resolveStorePath,
  resolveWorktreesDir,
  type AppServicesOptions,
} from "./application/defaults.js";
export { buildTaskInspection, toLatestAttemptSummary } from "./application/inspect-view.js";
