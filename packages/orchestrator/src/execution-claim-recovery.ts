import type { ExecutionClaim, IsoTimestamp, TaskStatus } from "@agentic-dev-runner/core";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import type { CrashRecovery } from "./crash-recovery.js";

export type ExecutionClaimRecoveryOutcome =
  | { readonly kind: "live"; readonly claim: ExecutionClaim }
  | { readonly kind: "safe-to-retry"; readonly claim: ExecutionClaim }
  | { readonly kind: "terminal-settled"; readonly claim: ExecutionClaim }
  | { readonly kind: "integration-recovery-required"; readonly claim: ExecutionClaim }
  | { readonly kind: "human-recovery-required"; readonly claim: ExecutionClaim };

export interface ExecutionClaimRecovery {
  reconcileExpired(): Promise<readonly ExecutionClaimRecoveryOutcome[]>;
}

/**
 * Reconciles only expired leases.  A lease is a liveness hint, not a verdict:
 * authoritative task/attempt recovery happens before a claim or its locks are
 * settled.  This keeps repeated startup reconciliation idempotent.
 */
export function createExecutionClaimRecovery(options: {
  readonly store: RunnerStore;
  readonly recovery: CrashRecovery;
  readonly now?: (() => IsoTimestamp) | undefined;
}): ExecutionClaimRecovery {
  const clock = options.now ?? (() => new Date().toISOString());
  return {
    async reconcileExpired(): Promise<readonly ExecutionClaimRecoveryOutcome[]> {
      const claims = await options.store.listExecutionClaims({ status: "ACTIVE" });
      const outcomes: ExecutionClaimRecoveryOutcome[] = [];
      for (const claim of claims) {
        if (claim.leaseExpiresAt > clock()) {
          outcomes.push({ kind: "live", claim });
          continue;
        }
        const queue = await options.store.listIntegrationQueueEntries({ executionId: claim.id });
        if (queue.some((entry) => entry.status === "PENDING" || entry.status === "INTEGRATING")) {
          outcomes.push({ kind: "integration-recovery-required", claim });
          continue;
        }
        const task = await options.store.getTask(claim.taskId);
        if (task === null) {
          outcomes.push({ kind: "human-recovery-required", claim });
          continue;
        }
        if (isTerminal(task.status)) {
          await options.store.releaseTaskExecution(claim.id, claimStatus(task.status), clock());
          outcomes.push({ kind: "terminal-settled", claim });
          continue;
        }
        const recovered = await options.recovery.reconcileTask(task.id);
        if (recovered.kind === "safe-to-retry") {
          await options.store.releaseTaskExecution(claim.id, "FAILED", clock(), {
            message: "expired execution lease reconciled; task is ready for a bounded retry",
          });
          outcomes.push({ kind: "safe-to-retry", claim });
          continue;
        }
        const refreshed = await options.store.getTask(task.id);
        if (refreshed !== null && isTerminal(refreshed.status)) {
          await options.store.releaseTaskExecution(claim.id, claimStatus(refreshed.status), clock());
          outcomes.push({ kind: "terminal-settled", claim });
        } else {
          outcomes.push({ kind: "human-recovery-required", claim });
        }
      }
      return outcomes;
    },
  };
}

function isTerminal(status: TaskStatus): boolean {
  return status === "DONE" || status === "FAILED" || status === "CANCELLED";
}

function claimStatus(status: TaskStatus): "COMPLETED" | "FAILED" | "CANCELLED" {
  return status === "DONE" ? "COMPLETED" : status === "CANCELLED" ? "CANCELLED" : "FAILED";
}
