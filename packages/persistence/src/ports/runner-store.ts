import type {
  Attempt,
  AttemptId,
  Project,
  ProjectId,
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

  appendEvents(events: readonly NewEvent[]): Promise<StoredEvent[]>;
  listEvents(filter?: EventFilter): Promise<StoredEvent[]>;

  transaction<T>(body: () => Promise<T>): Promise<T>;

  close(): Promise<void>;
}
