export { OrchestrationError } from "./orchestration-error.js";
export {
  ORCHESTRATION_EVENTS,
  type AttemptStartedPayload,
  type CommitCreatedPayload,
  type ImplementationCompletedPayload,
  type IntegrationCompletedPayload,
  type IntegrationQueuedPayload,
  type OrchestrationEventType,
  type RecoveryOutcomeKind,
  type RecoveryReconciledPayload,
  type TaskTransitionedPayload,
  type VerificationCompletedPayload,
  type WorktreeCleanupFailedPayload,
  type WorktreeCreatedPayload,
} from "./orchestration-events.js";
export type {
  CancelledRecovery,
  CancelledTaskRun,
  CompletedRecovery,
  CompletedTaskRun,
  FailedRecovery,
  FailedTaskRun,
  PendingIntegrationTaskRun,
  NoOpRecovery,
  RejectedTaskRun,
  RequiresHumanRecovery,
  RequiresReconciliationRecovery,
  RecoveryOutcome,
  SafeToRetryRecovery,
  SingleTaskRunOutcome,
  WorktreeCleanupOutcome,
} from "./orchestration-outcome.js";
export {
  createSingleTaskOrchestrator,
  type SingleTaskOrchestrator,
  type SingleTaskOrchestratorOptions,
} from "./single-task-orchestrator.js";
export {
  createCrashRecovery,
  RECOVERY_ACTIVE_STATUSES,
  type CrashRecovery,
  type CrashRecoveryOptions,
  type RecoveryActiveStatus,
} from "./crash-recovery.js";
export {
  createExecutionClaimRecovery,
  type ExecutionClaimRecovery,
  type ExecutionClaimRecoveryOutcome,
} from "./execution-claim-recovery.js";
export {
  createWorktreeRecovery,
  type WorktreeRecovery,
  type WorktreeRecoveryOutcome,
} from "./worktree-recovery.js";
export {
  CODE_REVIEW_STAGE_INSTRUCTION,
  codeReviewStageRunId,
  executeCodeReviewStage,
  type CodeReviewStageOptions,
  type CodeReviewStageOutcome,
} from "./code-review-stage.js";
export {
  PLAN_STAGE_INSTRUCTION,
  executePlanStage,
  planStageRunId,
  type PlanStageGuidance,
  type PlanStageOptions,
  type PlanStageOutcome,
} from "./plan-stage.js";
export {
  PLAN_REVIEW_STAGE_INSTRUCTION,
  executePlanReviewStage,
  planReviewStageRunId,
  type PlanReviewStageOptions,
  type PlanReviewStageOutcome,
} from "./plan-review-stage.js";
export {
  IMPLEMENT_STAGE_INSTRUCTION,
  executeImplementStage,
  implementStageRunId,
  type ImplementStageGuidance,
  type ImplementStageOptions,
  type ImplementStageOutcome,
} from "./implement-stage.js";
export {
  executePlanReviewFixLoop,
  executeCodeReviewFixLoop,
  type PlanReviewFixLoopOptions,
  type PlanReviewFixLoopOutcome,
  type CodeReviewFixLoopOptions,
  type CodeReviewFixLoopOutcome,
} from "./review-fix-loop.js";
export {
  describeTaskScopeViolations,
  matchesScopePattern,
  normalizeScopePath,
  validateTaskScope,
  type TaskScopeValidationResult,
  type TaskScopeViolation,
  type TaskScopeViolationKind,
} from "./task-scope.js";

export {
  createWorkflowTaskExecutor,
  type WorkflowTaskExecutor,
  type WorkflowTaskExecutorOptions,
} from "./workflow-executor.js";
export {
  createIntegrationDriftService,
  type IntegrationDriftEvaluationInput,
  type IntegrationDriftReconciliationInput,
  type IntegrationDriftService,
  type IntegrationDriftServiceOptions,
  type IntegrationReconciliationOutcome,
} from "./integration-drift.js";
export {
  resolveWorkflowFailure,
  type WorkflowFailureKind,
  type WorkflowFailureResolution,
} from "./workflow-failures.js";
export type {
  BlockedTaskRun,
  WorkflowTaskRunOutcome,
} from "./workflow-outcome.js";
export {
  createTaskExecutionCoordinator,
  type TaskAdmission,
  type TaskExecutionCoordinator,
  type TaskExecutionCoordinatorOptions,
  type TaskExecutionResult,
  type TaskDispatchResult,
} from "./task-execution-coordinator.js";
export {
  createIntegrationQueueProcessor,
  type IntegrationQueueProcessor,
  type IntegrationQueueProcessorOptions,
  type IntegrationQueueProcessorOutcome,
} from "./integration-queue-processor.js";
export {
  createUnattendedScheduler,
  type UnattendedScheduler,
  type UnattendedSchedulerCycle,
  type UnattendedSchedulerOptions,
  type UnattendedSchedulerResult,
} from "./unattended-scheduler.js";
export type {
  IntegrationVerificationCompletedPayload,
} from "./orchestration-events.js";
