import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { VerificationCheckSpec } from "@agentic-dev-runner/verification";

export type AppServicesOptions = {
  readonly projectRoot: string;
  readonly stateDir?: string | undefined;
  readonly storePath?: string | undefined;
  readonly worktreesDir?: string | undefined;
  readonly verificationChecks?: readonly VerificationCheckSpec[] | undefined;
  readonly agentTimeoutMs?: number | undefined;
  readonly maxParallelism?: number | undefined;
};

/**
 * Per-composition request. `tolerateInvalidConfiguration` is reserved for the
 * read-only `doctor` preflight, which must report configuration problems instead
 * of failing before a service exists. Every other command keeps fail-fast
 * construction.
 */
export type AppServicesRequest = {
  readonly tolerateInvalidConfiguration?: boolean | undefined;
};

export const STATE_ROOT_SEGMENT = join(".agentic", "projects");
export const STATE_DB_FILE_NAME = "state.db";
export const WORKTREES_DIR_NAME = "worktrees";

export const DEFAULT_PROJECT_ID = "proj-local";

export const DEFAULT_AGENT_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_MAX_PARALLELISM = 1;

const CASE_INSENSITIVE_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set([
  "win32",
  "darwin",
]);

export function resolveProjectRoot(projectRoot: string): string {
  return resolve(projectRoot);
}

export function normalizeProjectRootForIdentity(projectRoot: string): string {
  const absolute = resolveProjectRoot(projectRoot);
  return CASE_INSENSITIVE_PLATFORMS.has(process.platform)
    ? absolute.toLowerCase()
    : absolute;
}

export function projectKey(projectRoot: string): string {
  return createHash("sha256")
    .update(normalizeProjectRootForIdentity(projectRoot))
    .digest("hex")
    .slice(0, 16);
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

export function resolveVerificationChecks(
  options: AppServicesOptions,
): VerificationCheckSpec[] {
  return [...(options.verificationChecks ?? [])];
}

export function resolveAgentTimeoutMs(options: AppServicesOptions): number {
  return options.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
}

export function resolveMaxParallelism(options: AppServicesOptions): number {
  return options.maxParallelism ?? DEFAULT_MAX_PARALLELISM;
}
