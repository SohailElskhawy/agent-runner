export const TASK_TYPES = [
  "implementation",
  "bugfix",
  "refactor",
  "test",
  "documentation",
  "spike",
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

export type TaskPriority = `P${number}`;

export const TASK_RISKS = ["low", "medium", "high", "critical"] as const;

export type TaskRisk = (typeof TASK_RISKS)[number];

export const TASK_COMPLEXITIES = [
  "trivial",
  "small",
  "medium",
  "large",
] as const;

export type TaskComplexity = (typeof TASK_COMPLEXITIES)[number];

export const PROVENANCE_KINDS = [
  "roadmap_criterion",
  "user_request",
  "blocker",
  "verification_failure",
  "task_split",
] as const;

export type ProvenanceKind = (typeof PROVENANCE_KINDS)[number];

export type Provenance = {
  kind: ProvenanceKind;
  source: string;
};

export type TaskScope = {
  allowedPaths: readonly string[];
  forbiddenPaths: readonly string[];
};

export type TaskLimits = {
  maxAttempts: number;
  maxReviewCycles: number;
};

export type TaskApproval = {
  required: boolean;
  reason?: string;
};

export type TaskRouting = {
  complexity: TaskComplexity;
  capabilities: readonly string[];
};

export type TaskVerificationRequirement = {
  required: readonly string[];
};

export type TaskDefinition = {
  objective: string;
  acceptanceCriteria: readonly string[];
  scope: TaskScope;
  resources: readonly string[];
  verification: TaskVerificationRequirement;
  limits: TaskLimits;
  approval: TaskApproval;
};
