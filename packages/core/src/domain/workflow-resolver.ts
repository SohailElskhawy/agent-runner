/**
 * Pure, deterministic workflow resolution.
 *
 * Resolution maps a task's workflow id (see the task schema `workflow` field)
 * to a fixed, provider-independent built-in WorkflowDefinition. There is no
 * registration API, no custom or plugin workflows, and no execution: an
 * unknown workflow id yields a structured unknown-workflow result instead of
 * throwing. Built-in definitions are frozen and their stage order is fixed by
 * construction; validation still guards them so that an accidental invalid
 * definition fails loudly at module load rather than at execution time.
 */

import type { StageKind } from "./stage-run.js";
import type { WorkflowDefinition } from "./workflow-definition.js";
import { validateWorkflowDefinition } from "./workflow-definition.js";

export type WorkflowResolution =
  | { readonly resolved: true; readonly workflow: WorkflowDefinition }
  | {
      readonly resolved: false;
      readonly reason: "unknown-workflow";
      readonly workflowId: string;
    };

const SIMPLE_STAGES: readonly StageKind[] = Object.freeze([
  "IMPLEMENT",
  "VERIFY",
  "INTEGRATE",
]);

const DEFAULT_STAGES: readonly StageKind[] = Object.freeze([
  "PLAN",
  "PLAN_REVIEW",
  "IMPLEMENT",
  "CODE_REVIEW",
  "VERIFY",
  "INTEGRATE",
]);

export const BUILTIN_WORKFLOW_IDS: readonly string[] = Object.freeze([
  "simple",
  "default",
  "security-critical",
]);

export const SIMPLE_WORKFLOW: WorkflowDefinition = Object.freeze({
  id: "simple",
  stages: SIMPLE_STAGES,
});

export const DEFAULT_WORKFLOW: WorkflowDefinition = Object.freeze({
  id: "default",
  stages: DEFAULT_STAGES,
});

/**
 * `security-critical` intentionally reuses the same ordered stage sequence as
 * `default` in this slice; no additional security-critical behavior is
 * introduced here.
 */
export const SECURITY_CRITICAL_WORKFLOW: WorkflowDefinition = Object.freeze({
  id: "security-critical",
  stages: DEFAULT_STAGES,
});

const BUILTIN_WORKFLOWS: ReadonlyMap<string, WorkflowDefinition> = new Map([
  [SIMPLE_WORKFLOW.id, SIMPLE_WORKFLOW],
  [DEFAULT_WORKFLOW.id, DEFAULT_WORKFLOW],
  [SECURITY_CRITICAL_WORKFLOW.id, SECURITY_CRITICAL_WORKFLOW],
]);

for (const definition of BUILTIN_WORKFLOWS.values()) {
  const validation = validateWorkflowDefinition(definition);
  if (!validation.valid) {
    throw new Error(
      `Invalid built-in workflow definition "${definition.id}": ${validation.issues
        .map((issue) => JSON.stringify(issue))
        .join("; ")}`,
    );
  }
}

export function resolveWorkflow(workflowId: string): WorkflowResolution {
  const definition = BUILTIN_WORKFLOWS.get(workflowId);
  if (definition === undefined) {
    return { resolved: false, reason: "unknown-workflow", workflowId };
  }
  return { resolved: true, workflow: definition };
}
