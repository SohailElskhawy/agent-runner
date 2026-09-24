import type { IsoTimestamp } from "./timestamp.js";
import type { ProjectId, TaskId } from "./ids.js";
import type { TaskStatus } from "./task-status.js";
import type {
  TaskApproval,
  TaskDefinition,
  TaskPriority,
  TaskRisk,
  TaskRouting,
  TaskType,
  Provenance,
} from "./task-contract.js";

export type Task = {
  id: TaskId;
  projectId: ProjectId;
  title: string;
  milestone: string;
  status: TaskStatus;
  type: TaskType;
  priority: TaskPriority;
  risk: TaskRisk;
  definition: TaskDefinition;
  routing: TaskRouting;
  provenance: Provenance;
  dependsOn: readonly TaskId[];
  workflow: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  approvalGrantedAt?: IsoTimestamp;
};

export type { TaskApproval };
