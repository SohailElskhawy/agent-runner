import { join } from "node:path";
import type { IsoTimestamp, Task } from "@agentic-dev-runner/core";
import type { GitManager } from "@agentic-dev-runner/git";
import type { RunnerStore } from "@agentic-dev-runner/persistence";

export type WorktreeRecoveryOutcome =
  | { readonly kind: "removed"; readonly taskId: string; readonly path: string }
  | { readonly kind: "retained"; readonly taskId: string; readonly path: string; readonly reason: string }
  | { readonly kind: "absent"; readonly taskId: string; readonly path: string };

export interface WorktreeRecovery {
  reconcileTerminalWorktrees(): Promise<readonly WorktreeRecoveryOutcome[]>;
}

/** Runner-owned, fail-closed cleanup for terminal attempt worktrees. */
export function createWorktreeRecovery(options: {
  readonly store: RunnerStore;
  readonly git: GitManager;
  readonly projectRoot: string;
  readonly worktreesDir: string;
  readonly now?: (() => IsoTimestamp) | undefined;
}): WorktreeRecovery {
  return {
    async reconcileTerminalWorktrees(): Promise<readonly WorktreeRecoveryOutcome[]> {
      const outcomes: WorktreeRecoveryOutcome[] = [];
      for (const task of await options.store.listTasks()) {
        if (!isTerminal(task)) continue;
        const attempts = await options.store.listAttempts({ taskId: task.id });
        const attempt = attempts.at(-1);
        if (attempt === undefined) continue;
        const path = join(options.worktreesDir, task.id, `attempt-${String(attempt.number)}`);
        const live = (await options.store.listExecutionClaims({ taskId: task.id }))
          .some((claim) => claim.status === "ACTIVE");
        const queued = (await options.store.listIntegrationQueueEntries({ taskId: task.id }))
          .some((entry) => entry.status === "PENDING" || entry.status === "INTEGRATING");
        if (live || queued) {
          outcomes.push({ kind: "retained", taskId: task.id, path, reason: live ? "live-execution" : "integration-pending" });
          continue;
        }
        try {
          if (!(await options.git.worktreeExists(options.projectRoot, path))) {
            outcomes.push({ kind: "absent", taskId: task.id, path });
            continue;
          }
          if (!(await options.git.status(path)).clean) {
            outcomes.push({ kind: "retained", taskId: task.id, path, reason: "dirty-or-ambiguous" });
            continue;
          }
          await options.git.removeWorktree(options.projectRoot, path);
          outcomes.push({ kind: "removed", taskId: task.id, path });
        } catch {
          outcomes.push({ kind: "retained", taskId: task.id, path, reason: "git-state-unavailable" });
        }
      }
      return outcomes;
    },
  };
}

function isTerminal(task: Task): boolean {
  return task.status === "DONE" || task.status === "FAILED" || task.status === "CANCELLED";
}
