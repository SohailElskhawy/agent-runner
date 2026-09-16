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
 * Plan/review stages may precede the backbone. Validation is pure and
 * deterministic: identical input always produces an identical result, and
 * stage ordering is defined exclusively by the definition's stage sequence.
 */

import type { StageKind } from "./stage-run.js";

export const EXECUTION_BACKBONE_STAGES: readonly [
  "IMPLEMENT",
  "VERIFY",
  "INTEGRATE",
] = ["IMPLEMENT", "VERIFY", "INTEGRATE"];

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

  for (let i = 0; i < EXECUTION_BACKBONE_STAGES.length; i += 1) {
    const stage = EXECUTION_BACKBONE_STAGES[i];
    if (stage === undefined) {
      continue;
    }
    if (!firstIndexByStage.has(stage)) {
      issues.push({ reason: "missing-required-stage", stage });
      continue;
    }
    const nextStage = EXECUTION_BACKBONE_STAGES[i + 1];
    if (nextStage !== undefined && firstIndexByStage.has(nextStage)) {
      const stageIndex = firstIndexByStage.get(stage);
      const nextStageIndex = firstIndexByStage.get(nextStage);
      if (
        stageIndex !== undefined &&
        nextStageIndex !== undefined &&
        stageIndex > nextStageIndex
      ) {
        issues.push({
          reason: "invalid-stage-order",
          before: stage,
          after: nextStage,
        });
      }
    }
  }

  if (issues.length === 0) {
    return { valid: true, definition };
  }
  return { valid: false, issues };
}
