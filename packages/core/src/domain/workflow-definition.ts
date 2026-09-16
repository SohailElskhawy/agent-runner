/**
 * Representation-independent workflow definitions and their validation.
 *
 * A WorkflowDefinition assigns a stable workflow id to an ordered, bounded
 * sequence of lifecycle stages. Stage identifiers are the existing core
 * StageKind values; workflows are finite, fixed sequences — there is no
 * executable/plugin stage mechanism and no provider-specific behavior.
 *
 * In V0.1 every defined workflow is executable and must therefore contain the
 * execution backbone in canonical order:
 *
 *   IMPLEMENT → VERIFY → INTEGRATE
 *
 * Stage ordering is validated against the canonical V0.1 lifecycle:
 *
 *   PLAN → PLAN_REVIEW → IMPLEMENT → CODE_REVIEW → VERIFY → INTEGRATE
 *
 * A valid stage sequence is an ordered subsequence of that lifecycle (for
 * example, `simple` drops the plan/review stages), so no stage may appear
 * after a stage that canonically follows it — including the optional plan,
 * plan-review, and code-review stages. No ordering beyond the canonical
 * lifecycle is enforced. Validation is pure and deterministic: identical
 * input always produces an identical result, and stage ordering is defined
 * exclusively by the definition's stage sequence.
 */

import { STAGE_KINDS, type StageKind } from "./stage-run.js";

const EXECUTION_BACKBONE_STAGES: readonly StageKind[] = [
  "IMPLEMENT",
  "VERIFY",
  "INTEGRATE",
];

const CANONICAL_STAGE_RANK: ReadonlyMap<StageKind, number> = new Map(
  STAGE_KINDS.map((stage, index) => [stage, index] as const),
);

export type WorkflowDefinition = {
  readonly id: string;
  readonly stages: readonly StageKind[];
};

export type WorkflowValidationIssue =
  | { readonly reason: "empty-workflow-id" }
  | { readonly reason: "empty-stage-sequence" }
  | {
      readonly reason: "duplicate-stage";
      readonly stage: StageKind;
      readonly firstIndex: number;
      readonly duplicateIndex: number;
    }
  | {
      readonly reason: "invalid-stage-order";
      readonly before: StageKind;
      readonly after: StageKind;
    }
  | {
      readonly reason: "missing-required-stage";
      readonly stage: StageKind;
    };

export type WorkflowValidationResult =
  | { readonly valid: true; readonly definition: WorkflowDefinition }
  | {
      readonly valid: false;
      readonly issues: readonly WorkflowValidationIssue[];
    };

export function validateWorkflowDefinition(
  definition: WorkflowDefinition,
): WorkflowValidationResult {
  const issues: WorkflowValidationIssue[] = [];

  if (definition.id.trim().length === 0) {
    issues.push({ reason: "empty-workflow-id" });
  }

  if (definition.stages.length === 0) {
    issues.push({ reason: "empty-stage-sequence" });
  }

  const firstIndexByStage = new Map<StageKind, number>();
  for (let index = 0; index < definition.stages.length; index += 1) {
    const stage = definition.stages[index];
    if (stage === undefined) {
      continue;
    }
    const firstIndex = firstIndexByStage.get(stage);
    if (firstIndex === undefined) {
      firstIndexByStage.set(stage, index);
    } else {
      issues.push({
        reason: "duplicate-stage",
        stage,
        firstIndex,
        duplicateIndex: index,
      });
    }
  }

  for (let index = 1; index < definition.stages.length; index += 1) {
    const previous = definition.stages[index - 1];
    const current = definition.stages[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    const previousRank = CANONICAL_STAGE_RANK.get(previous);
    const currentRank = CANONICAL_STAGE_RANK.get(current);
    if (previousRank === undefined || currentRank === undefined) {
      continue;
    }
    if (previousRank > currentRank) {
      issues.push({
        reason: "invalid-stage-order",
        before: current,
        after: previous,
      });
    }
  }

  for (const stage of EXECUTION_BACKBONE_STAGES) {
    if (!firstIndexByStage.has(stage)) {
      issues.push({ reason: "missing-required-stage", stage });
    }
  }

  if (issues.length === 0) {
    return { valid: true, definition };
  }
  return { valid: false, issues };
}
