import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export type AppServicesOptions = {
  readonly projectRoot: string;
  readonly stateDir?: string | undefined;
  readonly storePath?: string | undefined;
  readonly worktreesDir?: string | undefined;
  readonly agentTimeoutMs?: number | undefined;
};

export const STATE_ROOT_SEGMENT = join(".agentic", "projects");
export const STATE_DB_FILE_NAME = "state.db";
export const WORKTREES_DIR_NAME = "worktrees";

export const DEFAULT_PROJECT_ID = "proj-local";

export const DEFAULT_AGENT_TIMEOUT_MS = 15 * 60 * 1000;

export function projectKey(projectRoot: string): string {
  return createHash("sha256").update(projectRoot).digest("hex").slice(0, 16);
}

export function defaultStateDir(projectRoot: string): string {
  return join(homedir(), STATE_ROOT_SEGMENT, projectKey(projectRoot));
}

function stateDirOf(options: AppServicesOptions): string {
  return options.stateDir ?? defaultStateDir(options.projectRoot);
}

export function resolveStorePath(options: AppServicesOptions): string {
  return options.storePath ?? join(stateDirOf(options), STATE_DB_FILE_NAME);
}

export function resolveWorktreesDir(options: AppServicesOptions): string {
  return options.worktreesDir ?? join(stateDirOf(options), WORKTREES_DIR_NAME);
}

export function resolveAgentTimeoutMs(options: AppServicesOptions): number {
  return options.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
}
