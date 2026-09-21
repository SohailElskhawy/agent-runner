import type {
  Attempt,
  AttemptId,
  ExecutionClaim,
  ExecutionClaimId,
  ExecutionClaimStatus,
  IntegrationQueueEntry,
  IntegrationQueueRequest,
  IntegrationQueueStatus,
  IsoTimestamp,
  Project,
  ProjectId,
  ResourceLock,
  StageRun,
  Task,
  TaskId,
} from "@agentic-dev-runner/core";
import type { NewEvent, StoredEvent } from "./event.js";

export type TaskFilter = {
  projectId?: ProjectId | undefined;
};

export type AttemptFilter = {
  taskId?: TaskId | undefined;
};

export type EventFilter = {
  taskId?: TaskId | undefined;
  type?: string | undefined;
};

/**
 * Selects the resource locks to release by ownership. At least one filter
 * field must be provided: a filter without fields would release every lock
 * in the store and is rejected deterministically.
 */
export type ResourceLockFilter = {
  readonly taskId?: TaskId | undefined;
  readonly attemptId?: AttemptId | undefined;
  readonly executionId?: ExecutionClaimId | undefined;
};

export type ExecutionClaimFilter = {
  readonly taskId?: TaskId | undefined;
  readonly status?: ExecutionClaimStatus | undefined;
};

export type TaskExecutionClaimRequest = {
  readonly taskId: TaskId;
  readonly executionId: ExecutionClaimId;
  readonly maxParallelism: number;
  readonly resources: readonly string[];
  readonly claimedAt: IsoTimestamp;
  readonly leaseExpiresAt: IsoTimestamp;
};

export type TaskExecutionClaimResult =
  | { readonly kind: "claimed"; readonly claim: ExecutionClaim }
  | {
      readonly kind:
        | "task-not-ready"
        | "already-claimed"
        | "capacity-exhausted"
        | "resource-unavailable";
      readonly taskId: TaskId;
    };

/**
 * Selects the integration queue entries to list. Every field is optional;
 * an empty filter lists the whole queue history.
 */
export type IntegrationQueueFilter = {
  readonly taskId?: TaskId | undefined;
  readonly attemptId?: AttemptId | undefined;
  readonly executionId?: ExecutionClaimId | undefined;
  readonly status?: IntegrationQueueStatus | undefined;
};

export interface RunnerStore {
  initialize(): Promise<void>;

  getProject(id: ProjectId): Promise<Project | null>;
  listProjects(): Promise<Project[]>;
  putProject(project: Project): Promise<void>;

  getTask(id: TaskId): Promise<Task | null>;
  listTasks(filter?: TaskFilter): Promise<Task[]>;
  putTask(task: Task): Promise<void>;

  getAttempt(id: AttemptId): Promise<Attempt | null>;
  listAttempts(filter?: AttemptFilter): Promise<Attempt[]>;
  putAttempt(attempt: Attempt): Promise<void>;

  listExecutionClaims(filter?: ExecutionClaimFilter): Promise<ExecutionClaim[]>;

  /**
   * Atomically reserves one global execution slot, claims a READY task, and
   * acquires its execution-owned resource locks.
   */
  claimTaskExecution(
    request: TaskExecutionClaimRequest,
  ): Promise<TaskExecutionClaimResult>;

  /** Renews only an active claim with the exact durable execution identity. */
  renewTaskExecution(
    executionId: ExecutionClaimId,
    renewedAt: IsoTimestamp,
    leaseExpiresAt: IsoTimestamp,
  ): Promise<boolean>;

  /** Atomically takes bounded recovery ownership of one expired active claim. */
  claimExpiredExecutionRecovery(
    executionId: ExecutionClaimId,
    recoveryOwnerId: string,
    now: IsoTimestamp,
    recoveryExpiresAt: IsoTimestamp,
  ): Promise<boolean>;

  /** Must be called inside a write transaction before recovery-owned mutation. */
  assertRecoveredExecutionOwner?(
    executionId: ExecutionClaimId,
    recoveryOwnerId: string,
    now: IsoTimestamp,
  ): Promise<void>;

  /** Completes/releases one execution claim and exactly its owned locks if currently active and unexpired. */
  releaseTaskExecution(
    executionId: ExecutionClaimId,
    status: Exclude<ExecutionClaimStatus, "ACTIVE">,
    finishedAt: IsoTimestamp,
    failure?: { readonly message: string } | undefined,
  ): Promise<boolean>;

  /** Settles a recovered claim only while its bounded recovery owner is current. */
  releaseRecoveredTaskExecution(
    executionId: ExecutionClaimId,
    recoveryOwnerId: string,
    status: Exclude<ExecutionClaimStatus, "ACTIVE">,
    finishedAt: IsoTimestamp,
    failure?: { readonly message: string } | undefined,
  ): Promise<boolean>;

  getTaskStatus(id: TaskId): Promise<Task["status"] | null>;
  setTaskStatus(
    id: TaskId,
    status: Task["status"],
    updatedAt: string,
  ): Promise<void>;

  putStageRun(stageRun: StageRun): Promise<void>;
  listStageRuns(attemptId: AttemptId): Promise<StageRun[]>;

  /**
   * Every currently held exclusive resource lock, ordered by resource.
   */
  listResourceLocks(filter?: ResourceLockFilter): Promise<ResourceLock[]>;

  /**
   * Acquires the given resource locks all-or-nothing inside one transaction.
   * When any resource is already held by a different owner the acquisition
   * fails and no lock is changed; locks already held by the same owner are
   * idempotent no-ops. Duplicate resources within the request must carry
   * the same ownership and collapse into a single lock.
   */
  acquireResourceLocks(locks: readonly ResourceLock[]): Promise<void>;

  /**
   * Releases exactly the locks matching the given ownership filter.
   */
  releaseResourceLocks(filter: ResourceLockFilter): Promise<void>;

  /**
   * Every integration queue entry matching the filter, in the canonical
   * deterministic queue order: enqueue sequence ascending, entry id
   * ascending. Completed and failed entries are preserved history and stay
   * listed until explicitly filtered out.
   */
  listIntegrationQueueEntries(
    filter?: IntegrationQueueFilter,
  ): Promise<IntegrationQueueEntry[]>;

  /**
   * Persists a new integration request for a prepared task/attempt as a
   * PENDING queue entry. The (task, attempt) pair must not already have an
   * active (PENDING or INTEGRATING) entry; a duplicate active enqueue is
   * rejected deterministically. Assigns the durable queue identity and
   * enqueue sequence and returns the persisted entry.
   */
  enqueueIntegrationQueueEntry(
    request: IntegrationQueueRequest,
  ): Promise<IntegrationQueueEntry>;

  /**
   * Atomically claims the next PENDING entry in canonical queue order for
   * integration, marking it INTEGRATING. At most one entry may be actively
   * integrating: when an entry is already INTEGRATING, or the queue holds
   * no PENDING entry, this returns null without changing anything. The
   * claim is atomic under SQLite concurrency; concurrent claimants never
   * claim the same entry.
   */
  claimNextIntegrationQueueEntry(
    claimedAt: IsoTimestamp,
  ): Promise<IntegrationQueueEntry | null>;

  /**
   * Marks the actively integrating entry with the given id COMPLETED.
   * Completing an entry that is not actively integrating fails
   * deterministically. The entry is preserved as history, never deleted.
   */
  completeIntegrationQueueEntry(id: string, finishedAt: IsoTimestamp): Promise<void>;

  /**
   * Marks the actively integrating entry with the given id FAILED with a
   * durable failure reason. Failing an entry that is not actively
   * integrating fails deterministically. The entry is preserved as
   * history, never deleted.
   */
  failIntegrationQueueEntry(
    id: string,
    failure: { readonly message: string },
    finishedAt: IsoTimestamp,
  ): Promise<void>;

  /** Returns an abandoned INTEGRATING entry to the serialized queue. */
  requeueIntegrationQueueEntry(id: string): Promise<void>;

  appendEvents(events: readonly NewEvent[]): Promise<StoredEvent[]>;
  listEvents(filter?: EventFilter): Promise<StoredEvent[]>;

  transaction<T>(body: () => Promise<T>): Promise<T>;

  close(): Promise<void>;
}
