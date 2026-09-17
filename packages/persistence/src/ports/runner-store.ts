import type {
  Attempt,
  AttemptId,
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

  appendEvents(events: readonly NewEvent[]): Promise<StoredEvent[]>;
  listEvents(filter?: EventFilter): Promise<StoredEvent[]>;

  transaction<T>(body: () => Promise<T>): Promise<T>;

  close(): Promise<void>;
}
