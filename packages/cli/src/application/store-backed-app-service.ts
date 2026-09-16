import { basename } from "node:path";
import {
  buildTaskFromManualInput,
  validateManualTaskInput,
  type Project,
  type TaskId,
} from "@agentic-dev-runner/core";
import type {
  CrashRecovery,
  SingleTaskOrchestrator,
  SingleTaskRunOutcome,
} from "@agentic-dev-runner/orchestrator";
import type { RunnerStore } from "@agentic-dev-runner/persistence";
import type { AgentRegistry } from "@agentic-dev-runner/agents";
import { CliError } from "../errors.js";
import {
  outcomeToRunResult,
  recoveryOutcomeToRunResult,
} from "./runner-app-service.js";
import type { RunnerAppService } from "./runner-app-service.js";
import type {
  AddTaskResult,
  AgentStatusEntry,
  InitResult,
  ProjectStatus,
  RunResult,
  TaskInspection,
} from "./ports.js";
import { buildTaskInspection, toLatestAttemptSummary } from "./inspect-view.js";
import type { TaskStatusEntry } from "./ports.js";
import { readTaskFile } from "./task-file.js";
import { DEFAULT_PROJECT_ID } from "./defaults.js";

export type StoreBackedAppServiceOptions = {
  readonly storePath: string;
  readonly projectRoot: string;
  readonly store: RunnerStore;
  readonly orchestrator: SingleTaskOrchestrator;
  readonly recovery: CrashRecovery;
  readonly agents: AgentRegistry;
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
  private readonly agents: AgentRegistry;
  private startupReconciliation: Promise<void> | undefined;

  constructor(options: StoreBackedAppServiceOptions) {
    this.storePath = options.storePath;
    this.projectRoot = options.projectRoot;
    this.store = options.store;
    this.orchestrator = options.orchestrator;
    this.recovery = options.recovery;
    this.agents = options.agents;
  }

  async init(): Promise<InitResult> {
    await this.startupReconcile();
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

  async addTask(taskFilePath: string): Promise<AddTaskResult> {
    await this.startupReconcile();
    const validation = validateManualTaskInput(readTaskFile(taskFilePath));
    if (!validation.ok) {
      throw new CliError(
        `invalid task definition in "${taskFilePath}": ${validation.issues.join("; ")}`,
      );
    }
    const project = (await this.store.listProjects()).at(0) ?? null;
    if (project === null) {
      throw new CliError(
        'runner is not initialized; run "agentic init" before adding tasks',
      );
    }
    const now = new Date().toISOString();
    const task = buildTaskFromManualInput(validation.value, {
      projectId: project.id,
      now,
    });
    await this.store.transaction(async () => {
      const existing = await this.store.getTask(task.id);
      if (existing !== null) {
        throw new CliError(
          `task "${task.id}" already exists in runner state; duplicate task IDs are rejected`,
        );
      }
      await this.store.putTask(task);
    });
    return {
      taskId: task.id,
      projectId: task.projectId,
      title: task.title,
      status: task.status,
    };
  }

  async run(taskId: TaskId): Promise<RunResult> {
    await this.startupReconcile();
    const recovery = await this.recovery.reconcileTask(taskId);
    const recoveryResult = recoveryOutcomeToRunResult(recovery);
    if (recoveryResult !== null) {
      return recoveryResult;
    }
    const outcome: SingleTaskRunOutcome = await this.orchestrator.run(taskId);
    return outcomeToRunResult(outcome);
  }

  async status(): Promise<ProjectStatus> {
    await this.startupReconcile();
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
    await this.startupReconcile();
    const task = await this.store.getTask(taskId);
    if (task === null) {
      return null;
    }
    const attempts = await this.store.listAttempts({ taskId });
    const events = await this.store.listEvents({ taskId });
    return buildTaskInspection({ task, attempts, events });
  }

  async listAgents(): Promise<readonly AgentStatusEntry[]> {
    const agents = await this.agents.discoverAgents();
    return agents.map((agent) => ({
      id: agent.id,
      available: agent.available,
      version: agent.version,
      reason: agent.reason,
    }));
  }

  async close(): Promise<void> {
    await this.store.close();
    this.startupReconciliation = undefined;
  }

  private startupReconcile(): Promise<void> {
    this.startupReconciliation ??= (async () => {
      await this.store.initialize();
      await this.recovery.reconcileUnfinished();
    })();
    return this.startupReconciliation;
  }
}
