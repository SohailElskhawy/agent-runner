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
  readonly recoveryLeaseDurationMs?: number | undefined;
}): ExecutionClaimRecovery {
  const clock = options.now ?? (() => new Date().toISOString());
  const recoveryLeaseDurationMs = options.recoveryLeaseDurationMs ?? 30_000;
  return {
    async reconcileExpired(): Promise<readonly ExecutionClaimRecoveryOutcome[]> {
      const claims = await options.store.listExecutionClaims({ status: "ACTIVE" });
      const outcomes: ExecutionClaimRecoveryOutcome[] = [];
      for (const claim of claims) {
        if (claim.leaseExpiresAt > clock()) {
          outcomes.push({ kind: "live", claim });
          continue;
        }
        const recoveryNow = clock();
        const recoveryOwnerId = `recovery_${randomUUID()}`;
        const owned = await options.store.claimExpiredExecutionRecovery(
          claim.id,
          recoveryOwnerId,
          recoveryNow,
          addLease(recoveryNow, recoveryLeaseDurationMs),
        );
        if (!owned) {
          // A competing restart owns recovery, or the original execution
          // renewed before the CAS. Never inspect or mutate it concurrently.
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
          const settled = await settle(options.store, claim.id, recoveryOwnerId, claimStatus(task.status), clock());
          outcomes.push(settled ? { kind: "terminal-settled", claim } : { kind: "human-recovery-required", claim });
          continue;
        }
        const recovered = await options.recovery.reconcileTask(task.id);
        if (recovered.kind === "safe-to-retry") {
          const settled = await settle(options.store, claim.id, recoveryOwnerId, "FAILED", clock(), {
            message: "expired execution lease reconciled; task is ready for a bounded retry",
          });
          outcomes.push(settled ? { kind: "safe-to-retry", claim } : { kind: "human-recovery-required", claim });
          continue;
        }
        const refreshed = await options.store.getTask(task.id);
        if (refreshed !== null && isTerminal(refreshed.status)) {
          const settled = await settle(options.store, claim.id, recoveryOwnerId, claimStatus(refreshed.status), clock());
          outcomes.push(settled ? { kind: "terminal-settled", claim } : { kind: "human-recovery-required", claim });
        } else {
          outcomes.push({ kind: "human-recovery-required", claim });
        }
      }
      return outcomes;
    },
  };
}

async function settle(
  store: RunnerStore,
  executionId: string,
  recoveryOwnerId: string,
  status: "COMPLETED" | "FAILED" | "CANCELLED",
  finishedAt: IsoTimestamp,
  failure?: { readonly message: string },
): Promise<boolean> {
  return await store.releaseRecoveredTaskExecution(executionId, recoveryOwnerId, status, finishedAt, failure);
}

function addLease(now: IsoTimestamp, durationMs: number): IsoTimestamp {
  const milliseconds = Date.parse(now);
  if (!Number.isFinite(milliseconds)) throw new Error(`invalid recovery timestamp ${now}`);
  return new Date(milliseconds + durationMs).toISOString();
}

function isTerminal(status: TaskStatus): boolean {
  return status === "DONE" || status === "FAILED" || status === "CANCELLED";
}

function claimStatus(status: TaskStatus): "COMPLETED" | "FAILED" | "CANCELLED" {
  return status === "DONE" ? "COMPLETED" : status === "CANCELLED" ? "CANCELLED" : "FAILED";
}
import { randomUUID } from "node:crypto";
