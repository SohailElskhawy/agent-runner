import type {
  IntegrationDriftEvaluation,
  IntegrationDriftFacts,
} from "@agentic-dev-runner/core";
import { evaluateIntegrationBaseDrift } from "@agentic-dev-runner/core";
import type { GitManager } from "@agentic-dev-runner/git";
import { OrchestrationError } from "./orchestration-error.js";

/**
 * Runner-controlled integration-base drift handling (M048a).
 *
 * Queued task attempts may wait while other tasks integrate, so their
 * implementation base can go stale before they are processed. Before a
 * queued task commit integrates, the runner classifies the drift against
 * the CURRENT integration HEAD — freshly resolved at evaluation time, never
 * a decision or HEAD recorded when the entry was enqueued — and reconciles
 * a drifted task branch by rebasing it onto the current integration HEAD
 * inside its isolated task worktree.
 *
 * The runner owns every Git operation here: agents never perform
 * integration and never run reconciliation. A rebase conflict stops
 * integration and returns the conflicted paths as explicit evidence; the
 * aborted rebase restores the original task commit, so no task change is
 * ever silently discarded. A reconciled branch is never immediately
 * integrable: the outcome reports `verificationRequired` so the runner
 * reruns the required verification on the reconciled result before
 * integration eligibility. Attempt records are never mutated, so the
 * original base revision stays inspectable in attempt history.
 */

export type IntegrationDriftEvaluationInput = {
  readonly baseRevision: string;
  readonly taskRevision: string;
};

export type IntegrationDriftReconciliationInput = {
  readonly baseRevision: string;
  readonly taskRevision: string;
  /** The isolated task worktree whose branch holds the task commit. */
  readonly worktreePath: string;
};

export type IntegrationReconciliationOutcome =
  | {
      readonly kind: "current";
      readonly baseRevision: string;
      readonly taskRevision: string;
      readonly integrationHead: string;
      readonly detail: string;
    }
  | {
      readonly kind: "already-integrated";
      readonly baseRevision: string;
      readonly taskRevision: string;
      readonly integrationHead: string;
      readonly detail: string;
    }
  | {
      readonly kind: "reconciled";
      readonly baseRevision: string;
      readonly previousTaskRevision: string;
      readonly taskRevision: string;
      readonly integrationHead: string;
      readonly detail: string;
      /** The reconciled result must pass verification before integrating. */
      readonly verificationRequired: true;
    }
  | {
      readonly kind: "conflict";
      readonly baseRevision: string;
      readonly taskRevision: string;
      readonly integrationHead: string;
      readonly conflictedPaths: readonly string[];
      readonly detail: string;
    }
  | {
      readonly kind: "unsafe";
      readonly baseRevision: string;
      readonly taskRevision: string;
      readonly integrationHead: string;
      readonly detail: string;
    }
  | {
      readonly kind: "failed";
      readonly baseRevision: string;
      readonly taskRevision: string;
      readonly integrationHead?: string | undefined;
      readonly detail: string;
    };

export interface IntegrationDriftService {
  evaluate(
    input: IntegrationDriftEvaluationInput,
  ): Promise<IntegrationDriftEvaluation>;
  reconcile(
    input: IntegrationDriftReconciliationInput,
  ): Promise<IntegrationReconciliationOutcome>;
}

export type IntegrationDriftServiceOptions = {
  readonly git: GitManager;
  readonly projectRoot: string;
};

export function createIntegrationDriftService(
  options: IntegrationDriftServiceOptions,
): IntegrationDriftService {
  return new GitIntegrationDriftService(options);
}

class GitIntegrationDriftService implements IntegrationDriftService {
  private readonly git: GitManager;
  private readonly projectRoot: string;

  constructor(options: IntegrationDriftServiceOptions) {
    validateOptions(options);
    this.git = options.git;
    this.projectRoot = options.projectRoot;
  }

  async evaluate(
    input: IntegrationDriftEvaluationInput,
  ): Promise<IntegrationDriftEvaluation> {
    validateInput(input.baseRevision, input.taskRevision);
    return await this.evaluateAgainstCurrentHead(
      input.baseRevision,
      input.taskRevision,
    );
  }

  async reconcile(
    input: IntegrationDriftReconciliationInput,
  ): Promise<IntegrationReconciliationOutcome> {
    validateInput(input.baseRevision, input.taskRevision);
    if (input.worktreePath.length === 0) {
      throw new OrchestrationError(
        "reconciliation requires the isolated task worktree path",
      );
    }
    const evaluation = await this.evaluateAgainstCurrentHead(
      input.baseRevision,
      input.taskRevision,
    );
    switch (evaluation.status) {
      case "CURRENT":
        return { kind: "current", ...sharedFields(evaluation), detail: evaluation.detail };
      case "ALREADY_INTEGRATED":
        return {
          kind: "already-integrated",
          ...sharedFields(evaluation),
          detail: evaluation.detail,
        };
      case "UNSAFE":
        return { kind: "unsafe", ...sharedFields(evaluation), detail: evaluation.detail };
      case "DRIFTED":
        return await this.reconcileDrift(evaluation, input);
    }
  }

  /**
   * Classifies the drift from freshly resolved Git state: the integration
   * HEAD is read at evaluation time so a queued entry is never judged by a
   * stale or enqueue-time view of the integration branch.
   */
  private async evaluateAgainstCurrentHead(
    baseRevision: string,
    taskRevision: string,
  ): Promise<IntegrationDriftEvaluation> {
    const integrationHead = await this.git.resolveHeadRevision(this.projectRoot);
    const facts: IntegrationDriftFacts = {
      baseRevision,
      taskRevision,
      integrationHead,
      taskCommitIntegrated: await this.git.isAncestor(
        this.projectRoot,
        taskRevision,
        integrationHead,
      ),
      baseIsAncestorOfIntegrationHead: await this.git.isAncestor(
        this.projectRoot,
        baseRevision,
        integrationHead,
      ),
      taskCommitDescendsFromBase: await this.git.isAncestor(
        this.projectRoot,
        baseRevision,
        taskRevision,
      ),
    };
    return evaluateIntegrationBaseDrift(facts);
  }

  private async reconcileDrift(
    evaluation: IntegrationDriftEvaluation,
    input: IntegrationDriftReconciliationInput,
  ): Promise<IntegrationReconciliationOutcome> {
    const shared = sharedFields(evaluation);
    let worktreeExists: boolean;
    try {
      worktreeExists = await this.git.worktreeExists(
        this.projectRoot,
        input.worktreePath,
      );
    } catch (error) {
      return {
        kind: "failed",
        ...shared,
        detail: `task worktree state is unavailable: ${describeError(error)}`,
      };
    }
    if (!worktreeExists) {
      return {
        kind: "failed",
        ...shared,
        detail: `task worktree "${input.worktreePath}" does not exist; the drifted task branch cannot be reconciled`,
      };
    }
    try {
      await this.git.rebaseBranch(input.worktreePath, evaluation.integrationHead);
    } catch (error) {
      return await this.handleRebaseFailure(evaluation, input, error);
    }
    const reconciledRevision = await this.git.resolveHeadRevision(
      input.worktreePath,
    );
    if (reconciledRevision === evaluation.integrationHead) {
      return {
        kind: "already-integrated",
        ...shared,
        detail: `reconciling onto integration HEAD ${evaluation.integrationHead} left no task change to integrate; the task changes are already contained in the integration branch`,
      };
    }
    return {
      kind: "reconciled",
      baseRevision: evaluation.baseRevision,
      previousTaskRevision: input.taskRevision,
      taskRevision: reconciledRevision,
      integrationHead: evaluation.integrationHead,
      detail: `task branch reconciled from ${input.taskRevision} to ${reconciledRevision} onto integration HEAD ${evaluation.integrationHead}; verification must rerun before integration`,
      verificationRequired: true,
    };
  }

  private async handleRebaseFailure(
    evaluation: IntegrationDriftEvaluation,
    input: IntegrationDriftReconciliationInput,
    error: unknown,
  ): Promise<IntegrationReconciliationOutcome> {
    const shared = sharedFields(evaluation);
    let conflictedPaths: readonly string[];
    try {
      conflictedPaths = await this.git.listUnmergedPaths(input.worktreePath);
    } catch (listError) {
      return {
        kind: "failed",
        ...shared,
        detail: `rebase failed (${describeError(error)}) and the conflicted paths could not be listed: ${describeError(listError)}`,
      };
    }
    if (conflictedPaths.length === 0) {
      return {
        kind: "failed",
        ...shared,
        detail: `rebase onto integration HEAD ${evaluation.integrationHead} failed: ${describeError(error)}`,
      };
    }
    await this.git.abortRebase(input.worktreePath);
    const restoredRevision = await this.git.resolveHeadRevision(
      input.worktreePath,
    );
    if (restoredRevision !== input.taskRevision) {
      return {
        kind: "failed",
        baseRevision: evaluation.baseRevision,
        taskRevision: input.taskRevision,
        integrationHead: evaluation.integrationHead,
        detail:
          `the conflicting rebase was aborted, but the task worktree points at ${restoredRevision} ` +
          `instead of the original task commit ${input.taskRevision}; a human must inspect the task worktree`,
      };
    }
    return {
      kind: "conflict",
      baseRevision: evaluation.baseRevision,
      taskRevision: input.taskRevision,
      integrationHead: evaluation.integrationHead,
      conflictedPaths,
      detail: `rebase onto integration HEAD ${evaluation.integrationHead} conflicts in ${conflictedPaths.length} path(s); integration is stopped and the original task commit ${input.taskRevision} is restored`,
    };
  }
}

function sharedFields(evaluation: IntegrationDriftEvaluation): {
  readonly baseRevision: string;
  readonly taskRevision: string;
  readonly integrationHead: string;
} {
  return {
    baseRevision: evaluation.baseRevision,
    taskRevision: evaluation.taskRevision,
    integrationHead: evaluation.integrationHead,
  };
}

function validateOptions(options: IntegrationDriftServiceOptions): void {
  if (options.projectRoot.length === 0) {
    throw new OrchestrationError("projectRoot must be a non-empty string");
  }
  if (options.git === undefined) {
    throw new OrchestrationError("git manager is required");
  }
}

function validateInput(baseRevision: string, taskRevision: string): void {
  if (baseRevision.length === 0) {
    throw new OrchestrationError("baseRevision must be a non-empty string");
  }
  if (taskRevision.length === 0) {
    throw new OrchestrationError("taskRevision must be a non-empty string");
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
