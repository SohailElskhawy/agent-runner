import { basename } from "node:path";
import type { Project, TaskId } from "@agentic-dev-runner/core";
import type {
  CrashRecovery,
  SingleTaskOrchestrator,
  SingleTaskRunOutcome,
} from "@agentic-dev-runner/orchestrator";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import {
  outcomeToRunResult,
  recoveryOutcomeToRunResult,
} from "./runner-app-service.js";
import type { RunnerAppService } from "./runner-app-service.js";
import type {
  InitResult,
  ProjectStatus,
  RunResult,
  TaskInspection,
} from "./ports.js";
import { buildTaskInspection, toLatestAttemptSummary } from "./inspect-view.js";
import type { TaskStatusEntry } from "./ports.js";
import { DEFAULT_PROJECT_ID } from "./defaults.js";

export type StoreBackedAppServiceOptions = {
  readonly storePath: string;
  readonly projectRoot: string;
  readonly store: RunnerStore;
  readonly orchestrator: SingleTaskOrchestrator;
  readonly recovery: CrashRecovery;
};

export function createStoreBackedAppService(
  options: StoreBackedAppServiceOptions,
): RunnerAppService {
  return new StoreBackedAppService(options);
}

class StoreBackedAppService implements RunnerAppService {
  private readonly storePath: string;
  private readonly projectRoot: string;
  private readonly store: RunnerStore;
  private readonly orchestrator: SingleTaskOrchestrator;
  private readonly recovery: CrashRecovery;

  constructor(options: StoreBackedAppServiceOptions) {
    this.storePath = options.storePath;
    this.projectRoot = options.projectRoot;
    this.store = options.store;
    this.orchestrator = options.orchestrator;
    this.recovery = options.recovery;
  }

  async init(): Promise<InitResult> {
    await this.store.initialize();
    const existing = await this.store.getProject(DEFAULT_PROJECT_ID);
    if (existing === null) {
      const now = new Date().toISOString();
      const project: Project = {
        id: DEFAULT_PROJECT_ID,
        name: basename(this.projectRoot) || this.projectRoot,
        rootPath: this.projectRoot,
        createdAt: now,
        updatedAt: now,
      };
      await this.store.putProject(project);
    }
    return {
      projectId: DEFAULT_PROJECT_ID,
      projectRoot: this.projectRoot,
      storePath: this.storePath,
    };
  }

  async run(taskId: TaskId): Promise<RunResult> {
    await this.store.initialize();
    const recovery = await this.recovery.reconcileTask(taskId);
    const recoveryResult = recoveryOutcomeToRunResult(recovery);
    if (recoveryResult !== null) {
      return recoveryResult;
    }
    const outcome: SingleTaskRunOutcome = await this.orchestrator.run(taskId);
    return outcomeToRunResult(outcome);
  }

  async status(): Promise<ProjectStatus> {
    await this.store.initialize();
    const project = (await this.store.listProjects()).at(0) ?? null;
    const tasks = await this.store.listTasks();
    const entries: TaskStatusEntry[] = [];
    for (const task of tasks) {
      const attempts = await this.store.listAttempts({ taskId: task.id });
      entries.push({
        id: task.id,
        title: task.title,
        status: task.status,
        updatedAt: task.updatedAt,
        attemptCount: attempts.length,
        latestAttempt: toLatestAttemptSummary(attempts.at(-1)),
      });
    }
    return { project, tasks: entries };
  }

  async inspect(taskId: TaskId): Promise<TaskInspection | null> {
    await this.store.initialize();
    const task = await this.store.getTask(taskId);
    if (task === null) {
      return null;
    }
    const attempts = await this.store.listAttempts({ taskId });
    const events = await this.store.listEvents({ taskId });
    return buildTaskInspection({ task, attempts, events });
  }

  async close(): Promise<void> {
    await this.store.close();
  }
}
