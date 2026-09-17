/**
 * Integration-base drift classification.
 *
 * A task attempt is implemented against a base revision of the integration
 * branch. While tasks queue for serialized integration, the integration
 * branch may advance, so the attempt's base can become stale. Before
 * integrating a queued task commit, the runner must classify the drift
 * against the CURRENT integration HEAD — never against a decision or HEAD
 * recorded at enqueue time.
 *
 * Given the authoritative ancestry facts between the attempt's base
 * revision, the task commit, and the current integration HEAD, this pure
 * classifier deterministically distinguishes:
 *
 *   ALREADY_INTEGRATED — the task commit is already contained in the
 *     integration HEAD; integrating again would duplicate it.
 *   UNSAFE — the recorded histories are inconsistent or unexpected (the
 *     task commit does not descend from its recorded base, or the
 *     integration HEAD is not a descendant of that base). Integration must
 *     not proceed.
 *   CURRENT — the integration HEAD still equals the attempt base; no drift
 *     exists.
 *   DRIFTED — the integration HEAD advanced past the attempt base while the
 *     task commit is not integrated; the task branch must be reconciled
 *     (rebased) onto the current integration HEAD by the runner before
 *     integration eligibility, and conflicts must stop integration.
 *
 * The classifier is pure: it never runs Git, never mutates inputs, and
 * produces identical results for identical facts. Whether a drifted task
 * commit is "safely reconcilable" is decided only by attempting the
 * runner-controlled reconciliation — a stale base is never assumed safe by
 * classification alone.
 */

export const INTEGRATION_DRIFT_STATUSES = [
  "ALREADY_INTEGRATED",
  "UNSAFE",
  "CURRENT",
  "DRIFTED",
] as const;

export type IntegrationDriftStatus = (typeof INTEGRATION_DRIFT_STATUSES)[number];

export type IntegrationDriftFacts = {
  readonly baseRevision: string;
  readonly taskRevision: string;
  readonly integrationHead: string;
  /** Whether the task commit is an ancestor of the integration HEAD. */
  readonly taskCommitIntegrated: boolean;
  /** Whether the attempt base is an ancestor of the integration HEAD. */
  readonly baseIsAncestorOfIntegrationHead: boolean;
  /** Whether the task commit descends from the attempt base. */
  readonly taskCommitDescendsFromBase: boolean;
};

export type IntegrationDriftEvaluation = {
  readonly status: IntegrationDriftStatus;
  readonly baseRevision: string;
  readonly taskRevision: string;
  readonly integrationHead: string;
  /** Deterministic explanation of the classification. */
  readonly detail: string;
};

export function evaluateIntegrationBaseDrift(
  facts: IntegrationDriftFacts,
): IntegrationDriftEvaluation {
  const evaluation = {
    baseRevision: facts.baseRevision,
    taskRevision: facts.taskRevision,
    integrationHead: facts.integrationHead,
  };
  if (facts.taskCommitIntegrated) {
    return {
      ...evaluation,
      status: "ALREADY_INTEGRATED",
      detail: `task commit ${facts.taskRevision} is already contained in integration HEAD ${facts.integrationHead}; integrating again would duplicate the task commit`,
    };
  }
  if (!facts.taskCommitDescendsFromBase) {
    return {
      ...evaluation,
      status: "UNSAFE",
      detail: `task commit ${facts.taskRevision} does not descend from its recorded attempt base ${facts.baseRevision}; the recorded histories are inconsistent`,
    };
  }
  if (facts.integrationHead === facts.baseRevision) {
    return {
      ...evaluation,
      status: "CURRENT",
      detail: `integration HEAD ${facts.integrationHead} still equals the attempt base ${facts.baseRevision}; no integration-base drift exists`,
    };
  }
  if (!facts.baseIsAncestorOfIntegrationHead) {
    return {
      ...evaluation,
      status: "UNSAFE",
      detail: `integration HEAD ${facts.integrationHead} is not a descendant of the attempt base ${facts.baseRevision}; the integration history diverged from the task base`,
    };
  }
  return {
    ...evaluation,
    status: "DRIFTED",
    detail: `integration HEAD advanced from the attempt base ${facts.baseRevision} to ${facts.integrationHead}; the task branch must be reconciled onto the current integration HEAD before integrating`,
  };
}
