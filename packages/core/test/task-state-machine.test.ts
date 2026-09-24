import { describe, expect, it } from "vitest";
import {
  TASK_STATUSES,
  assertReconcileTaskStatus,
  assertTaskTransition,
  canReconcileTaskStatus,
  canTransitionTaskStatus,
  checkTaskTransition,
  getTaskRecoveryStatusTransitions,
  getTaskStatusTransitions,
  TaskTransitionError,
} from "@agentic-dev-runner/core";

const ACTIVE_WORKFLOW_STATES = [
  "READY",
  "PLANNING",
  "PLAN_REVIEW",
  "IMPLEMENTING",
  "CODE_REVIEW",
  "VERIFYING",
  "INTEGRATING",
] as const;

const STAGE_ACTIVE_STATES = [
  "PLANNING",
  "PLAN_REVIEW",
  "IMPLEMENTING",
  "CODE_REVIEW",
  "VERIFYING",
  "INTEGRATING",
] as const;

const TERMINAL_STATES = ["DONE", "CANCELLED"] as const;

const UNSUPPORTED_STATES = ["BACKLOG"] as const;

const ESCALATION_STATES = ["BLOCKED", "FAILED", "CANCELLED"] as const;

describe("explicit transition table", () => {
  it("covers every task status explicitly", () => {
    for (const status of TASK_STATUSES) {
      expect(getTaskStatusTransitions(status)).toBeDefined();
    }
  });

  it("matches the canonical workflow lifecycle table", () => {
    expect([...getTaskStatusTransitions("READY")]).toEqual([
      "PLANNING",
      "IMPLEMENTING",
      ...ESCALATION_STATES,
    ]);
    expect([...getTaskStatusTransitions("PLANNING")]).toEqual([
      "PLAN_REVIEW",
      "IMPLEMENTING",
      ...ESCALATION_STATES,
    ]);
    expect([...getTaskStatusTransitions("PLAN_REVIEW")]).toEqual([
      "PLANNING",
      "IMPLEMENTING",
      ...ESCALATION_STATES,
    ]);
    expect([...getTaskStatusTransitions("IMPLEMENTING")]).toEqual([
      "CODE_REVIEW",
      "VERIFYING",
      ...ESCALATION_STATES,
    ]);
    expect([...getTaskStatusTransitions("CODE_REVIEW")]).toEqual([
      "IMPLEMENTING",
      "VERIFYING",
      ...ESCALATION_STATES,
    ]);
    expect([...getTaskStatusTransitions("VERIFYING")]).toEqual([
      "INTEGRATING",
      ...ESCALATION_STATES,
    ]);
    expect([...getTaskStatusTransitions("INTEGRATING")]).toEqual([
      "DONE",
      ...ESCALATION_STATES,
    ]);
    expect([...getTaskStatusTransitions("NEEDS_HUMAN")]).toEqual(["READY"]);
    expect([...getTaskStatusTransitions("BLOCKED")]).toEqual(["READY"]);
    expect([...getTaskStatusTransitions("DONE")]).toEqual([]);
    expect([...getTaskStatusTransitions("FAILED")]).toEqual(["READY"]);
    expect([...getTaskStatusTransitions("CANCELLED")]).toEqual([]);
  });
});

describe("valid transitions", () => {
  it("allows the full canonical workflow happy-path chain", () => {
    expect(canTransitionTaskStatus("READY", "PLANNING")).toBe(true);
    expect(canTransitionTaskStatus("PLANNING", "PLAN_REVIEW")).toBe(true);
    expect(canTransitionTaskStatus("PLAN_REVIEW", "IMPLEMENTING")).toBe(true);
    expect(canTransitionTaskStatus("IMPLEMENTING", "CODE_REVIEW")).toBe(true);
    expect(canTransitionTaskStatus("CODE_REVIEW", "VERIFYING")).toBe(true);
    expect(canTransitionTaskStatus("VERIFYING", "INTEGRATING")).toBe(true);
    expect(canTransitionTaskStatus("INTEGRATING", "DONE")).toBe(true);
  });

  it("allows the vertical-slice path of workflows without optional stages", () => {
    expect(canTransitionTaskStatus("READY", "IMPLEMENTING")).toBe(true);
    expect(canTransitionTaskStatus("IMPLEMENTING", "VERIFYING")).toBe(true);
    expect(canTransitionTaskStatus("VERIFYING", "INTEGRATING")).toBe(true);
    expect(canTransitionTaskStatus("INTEGRATING", "DONE")).toBe(true);
  });

  it("allows PLAN review fix cycles to return to PLANNING and back", () => {
    expect(canTransitionTaskStatus("PLAN_REVIEW", "PLANNING")).toBe(true);
    expect(canTransitionTaskStatus("PLANNING", "PLAN_REVIEW")).toBe(true);
  });

  it("allows CODE review fix cycles to return to IMPLEMENTING and back", () => {
    expect(canTransitionTaskStatus("CODE_REVIEW", "IMPLEMENTING")).toBe(true);
    expect(canTransitionTaskStatus("IMPLEMENTING", "CODE_REVIEW")).toBe(true);
  });

  it("allows optional workflow stages to be skipped", () => {
    expect(canTransitionTaskStatus("PLANNING", "IMPLEMENTING")).toBe(true);
    expect(canTransitionTaskStatus("PLAN_REVIEW", "IMPLEMENTING")).toBe(true);
    expect(canTransitionTaskStatus("IMPLEMENTING", "VERIFYING")).toBe(true);
  });

  it("allows every active workflow state to escalate to BLOCKED, FAILED, and CANCELLED", () => {
    for (const from of ACTIVE_WORKFLOW_STATES) {
      for (const to of ESCALATION_STATES) {
        expect(canTransitionTaskStatus(from, to)).toBe(true);
      }
    }
  });

  it("allows an unblocked task to return to READY", () => {
    expect(canTransitionTaskStatus("BLOCKED", "READY")).toBe(true);
  });

  it("allows the runner to retry failed and needs-human tasks", () => {
    expect(canTransitionTaskStatus("FAILED", "READY")).toBe(true);
    expect(canTransitionTaskStatus("NEEDS_HUMAN", "READY")).toBe(true);
    expect(canTransitionTaskStatus("BLOCKED", "READY")).toBe(true);
    expect(canTransitionTaskStatus("DONE", "READY")).toBe(false);
    expect(canTransitionTaskStatus("CANCELLED", "READY")).toBe(false);
  });

  it("returns ok results carrying the transition for valid moves", () => {
    const result = checkTaskTransition("PLANNING", "PLAN_REVIEW");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.from).toBe("PLANNING");
      expect(result.to).toBe("PLAN_REVIEW");
    }
  });

  it("produces identical results for repeated calls", () => {
    expect(checkTaskTransition("VERIFYING", "INTEGRATING")).toEqual(
      checkTaskTransition("VERIFYING", "INTEGRATING"),
    );
    expect(checkTaskTransition("DONE", "READY")).toEqual(
      checkTaskTransition("DONE", "READY"),
    );
  });
});

describe("invalid transitions", () => {
  it("rejects skipping stages", () => {
    expect(canTransitionTaskStatus("READY", "VERIFYING")).toBe(false);
    expect(canTransitionTaskStatus("READY", "DONE")).toBe(false);
    expect(canTransitionTaskStatus("PLANNING", "VERIFYING")).toBe(false);
    expect(canTransitionTaskStatus("PLAN_REVIEW", "VERIFYING")).toBe(false);
    expect(canTransitionTaskStatus("IMPLEMENTING", "DONE")).toBe(false);
    expect(canTransitionTaskStatus("IMPLEMENTING", "INTEGRATING")).toBe(false);
    expect(canTransitionTaskStatus("CODE_REVIEW", "INTEGRATING")).toBe(false);
    expect(canTransitionTaskStatus("VERIFYING", "DONE")).toBe(false);
  });

  it("rejects skipping backward out of a review cycle", () => {
    expect(canTransitionTaskStatus("PLAN_REVIEW", "READY")).toBe(false);
    expect(canTransitionTaskStatus("CODE_REVIEW", "PLANNING")).toBe(false);
  });

  it("rejects reversing and re-entering stages", () => {
    expect(canTransitionTaskStatus("VERIFYING", "IMPLEMENTING")).toBe(false);
    expect(canTransitionTaskStatus("VERIFYING", "PLANNING")).toBe(false);
    expect(canTransitionTaskStatus("INTEGRATING", "VERIFYING")).toBe(false);
    expect(canTransitionTaskStatus("INTEGRATING", "READY")).toBe(false);
    expect(canTransitionTaskStatus("DONE", "INTEGRATING")).toBe(false);
    expect(canTransitionTaskStatus("BLOCKED", "INTEGRATING")).toBe(false);
    expect(canTransitionTaskStatus("BLOCKED", "FAILED")).toBe(false);
  });

  it("rejects every transition out of terminal states", () => {
    for (const from of TERMINAL_STATES) {
      for (const to of TASK_STATUSES) {
        expect(canTransitionTaskStatus(from, to)).toBe(false);
      }
    }
  });

  it("rejects every transition out of states that do not belong to the lifecycle", () => {
    for (const from of UNSUPPORTED_STATES) {
      for (const to of TASK_STATUSES) {
        expect(canTransitionTaskStatus(from, to)).toBe(false);
      }
    }
  });

  it("keeps recovery-only transitions out of the normal execution table", () => {
    for (const from of STAGE_ACTIVE_STATES) {
      expect(canTransitionTaskStatus(from, "NEEDS_HUMAN")).toBe(false);
    }
    expect(canTransitionTaskStatus("FAILED", "DONE")).toBe(false);
  });

  it("returns failing results carrying the rejected transition", () => {
    const result = checkTaskTransition("DONE", "READY");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.from).toBe("DONE");
      expect(result.to).toBe("READY");
    }
  });
});

describe("recovery transition table", () => {
  it("extends only the reconciliation-specific transitions", () => {
    expect([...getTaskRecoveryStatusTransitions("FAILED")]).toEqual(["DONE"]);
    for (const from of STAGE_ACTIVE_STATES) {
      expect([...getTaskRecoveryStatusTransitions(from)]).toEqual([
        "NEEDS_HUMAN",
      ]);
    }
    for (const status of TASK_STATUSES) {
      if (
        !(STAGE_ACTIVE_STATES as readonly string[]).includes(status) &&
        status !== "FAILED"
      ) {
        expect(getTaskRecoveryStatusTransitions(status)).toEqual([]);
      }
    }
  });

  it("classifies the canonical workflow stage states as recovery-active", () => {
    for (const from of STAGE_ACTIVE_STATES) {
      expect(canReconcileTaskStatus(from, "NEEDS_HUMAN")).toBe(true);
    }
    expect(canReconcileTaskStatus("READY", "NEEDS_HUMAN")).toBe(false);
  });

  it("allows crash recovery to converge an integrated task persisted as FAILED to DONE, plus the normal retry transition", () => {
    expect(canReconcileTaskStatus("FAILED", "DONE")).toBe(true);
    expect(canReconcileTaskStatus("FAILED", "READY")).toBe(true);
    for (const to of TASK_STATUSES) {
      if (to === "DONE" || to === "READY") {
        continue;
      }
      expect(canReconcileTaskStatus("FAILED", to)).toBe(false);
    }
  });

  it("allows every normal transition during reconciliation", () => {
    for (const from of ACTIVE_WORKFLOW_STATES) {
      for (const to of ESCALATION_STATES) {
        expect(canReconcileTaskStatus(from, to)).toBe(true);
      }
    }
    expect(canReconcileTaskStatus("BLOCKED", "READY")).toBe(true);
    expect(canReconcileTaskStatus("INTEGRATING", "DONE")).toBe(true);
  });
});

describe("assertTaskTransition", () => {
  it("does not throw for valid transitions", () => {
    expect(() => assertTaskTransition("READY", "PLANNING")).not.toThrow();
    expect(() => assertTaskTransition("READY", "IMPLEMENTING")).not.toThrow();
    expect(() => assertTaskTransition("PLANNING", "IMPLEMENTING")).not.toThrow();
    expect(() => assertTaskTransition("INTEGRATING", "DONE")).not.toThrow();
  });

  it("throws a typed domain error for invalid transitions", () => {
    try {
      assertTaskTransition("DONE", "READY");
      expect.unreachable("expected invalid transition to throw");
    } catch (error) {
      if (error instanceof TaskTransitionError) {
        expect(error.from).toBe("DONE");
        expect(error.to).toBe("READY");
        expect(error.name).toBe("TaskTransitionError");
        expect(error.message).toBe(
          "Illegal task status transition: DONE -> READY",
        );
      } else {
        expect.unreachable("expected TaskTransitionError");
      }
    }
  });

  it("throws for transitions out of unsupported states", () => {
    expect(() => assertTaskTransition("BACKLOG", "READY")).toThrow(
      TaskTransitionError,
    );
    expect(() => assertTaskTransition("PLANNING", "VERIFYING")).toThrow(
      TaskTransitionError,
    );
    expect(() => assertTaskTransition("CODE_REVIEW", "DONE")).toThrow(
      TaskTransitionError,
    );
  });

  it("blocks recovery-only transitions outside recovery", () => {
    expect(() => assertTaskTransition("FAILED", "DONE")).toThrow(
      TaskTransitionError,
    );
    expect(() => assertTaskTransition("INTEGRATING", "NEEDS_HUMAN")).toThrow(
      TaskTransitionError,
    );
    expect(() => assertTaskTransition("PLANNING", "NEEDS_HUMAN")).toThrow(
      TaskTransitionError,
    );
  });
});

describe("assertReconcileTaskStatus", () => {
  it("allows the recovery convergence of an integrated FAILED task to DONE", () => {
    expect(() => assertReconcileTaskStatus("FAILED", "DONE")).not.toThrow();
  });

  it("allows recovery escalation of canonical workflow states to NEEDS_HUMAN", () => {
    for (const from of STAGE_ACTIVE_STATES) {
      expect(() => assertReconcileTaskStatus(from, "NEEDS_HUMAN")).not.toThrow();
    }
  });

  it("allows normal transitions during recovery", () => {
    expect(() =>
      assertReconcileTaskStatus("INTEGRATING", "DONE"),
    ).not.toThrow();
    expect(() =>
      assertReconcileTaskStatus("IMPLEMENTING", "BLOCKED"),
    ).not.toThrow();
    expect(() =>
      assertReconcileTaskStatus("PLAN_REVIEW", "BLOCKED"),
    ).not.toThrow();
    expect(() =>
      assertReconcileTaskStatus("CODE_REVIEW", "CANCELLED"),
    ).not.toThrow();
    expect(() =>
      assertReconcileTaskStatus("BLOCKED", "READY"),
    ).not.toThrow();
    expect(() =>
      assertReconcileTaskStatus("FAILED", "READY"),
    ).not.toThrow();
    expect(() =>
      assertReconcileTaskStatus("NEEDS_HUMAN", "READY"),
    ).not.toThrow();
  });

  it("throws for transitions outside both tables", () => {
    expect(() => assertReconcileTaskStatus("DONE", "READY")).toThrow(
      TaskTransitionError,
    );
    expect(() => assertReconcileTaskStatus("READY", "NEEDS_HUMAN")).toThrow(
      TaskTransitionError,
    );
  });
});
