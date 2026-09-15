import { describe, expect, it } from "vitest";
import {
  TASK_STATUSES,
  assertTaskTransition,
  canTransitionTaskStatus,
  checkTaskTransition,
  getTaskStatusTransitions,
  TaskTransitionError,
} from "@agentic-dev-runner/core";

const VERTICAL_SLICE_ACTIVE_STATES = [
  "READY",
  "IMPLEMENTING",
  "VERIFYING",
  "INTEGRATING",
] as const;

const EXECUTION_STATES = ["IMPLEMENTING", "VERIFYING", "INTEGRATING"] as const;

const TERMINAL_STATES = ["DONE", "CANCELLED", "NEEDS_HUMAN"] as const;

const UNSUPPORTED_STATES = [
  "BACKLOG",
  "PLANNING",
  "PLAN_REVIEW",
  "CODE_REVIEW",
] as const;

const ESCALATION_STATES = ["BLOCKED", "FAILED", "CANCELLED"] as const;

const RECOVERY_ESCALATION_STATES = [
  "BLOCKED",
  "NEEDS_HUMAN",
  "FAILED",
  "CANCELLED",
] as const;

describe("explicit transition table", () => {
  it("covers every task status explicitly", () => {
    for (const status of TASK_STATUSES) {
      expect(getTaskStatusTransitions(status)).toBeDefined();
    }
  });

  it("matches the documented vertical-slice execution path", () => {
    expect([...getTaskStatusTransitions("READY")]).toEqual([
      "IMPLEMENTING",
      ...ESCALATION_STATES,
    ]);
    expect([...getTaskStatusTransitions("IMPLEMENTING")]).toEqual([
      "VERIFYING",
      ...RECOVERY_ESCALATION_STATES,
    ]);
    expect([...getTaskStatusTransitions("VERIFYING")]).toEqual([
      "INTEGRATING",
      ...RECOVERY_ESCALATION_STATES,
    ]);
    expect([...getTaskStatusTransitions("INTEGRATING")]).toEqual([
      "DONE",
      ...RECOVERY_ESCALATION_STATES,
    ]);
    expect([...getTaskStatusTransitions("NEEDS_HUMAN")]).toEqual([]);
    expect([...getTaskStatusTransitions("BLOCKED")]).toEqual(["READY"]);
    expect([...getTaskStatusTransitions("DONE")]).toEqual([]);
    expect([...getTaskStatusTransitions("FAILED")]).toEqual(["DONE"]);
    expect([...getTaskStatusTransitions("CANCELLED")]).toEqual([]);
  });

  it("allows crash recovery to converge an integrated task persisted as FAILED to DONE only", () => {
    expect(canTransitionTaskStatus("FAILED", "DONE")).toBe(true);
    for (const to of TASK_STATUSES) {
      if (to === "DONE") {
        continue;
      }
      expect(canTransitionTaskStatus("FAILED", to)).toBe(false);
    }
  });
});

describe("valid transitions", () => {
  it("allows the full vertical-slice execution path", () => {
    expect(canTransitionTaskStatus("READY", "IMPLEMENTING")).toBe(true);
    expect(canTransitionTaskStatus("IMPLEMENTING", "VERIFYING")).toBe(true);
    expect(canTransitionTaskStatus("VERIFYING", "INTEGRATING")).toBe(true);
    expect(canTransitionTaskStatus("INTEGRATING", "DONE")).toBe(true);
  });

  it("allows active vertical-slice states to escalate to BLOCKED, FAILED, and CANCELLED", () => {
    for (const from of VERTICAL_SLICE_ACTIVE_STATES) {
      for (const to of ESCALATION_STATES) {
        expect(canTransitionTaskStatus(from, to)).toBe(true);
      }
    }
  });

  it("allows execution states to escalate to NEEDS_HUMAN for crash recovery", () => {
    for (const from of EXECUTION_STATES) {
      expect(canTransitionTaskStatus(from, "NEEDS_HUMAN")).toBe(true);
    }
    expect(canTransitionTaskStatus("READY", "NEEDS_HUMAN")).toBe(false);
  });

  it("allows an unblocked task to return to READY", () => {
    expect(canTransitionTaskStatus("BLOCKED", "READY")).toBe(true);
  });

  it("returns ok results carrying the transition for valid moves", () => {
    const result = checkTaskTransition("IMPLEMENTING", "VERIFYING");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.from).toBe("IMPLEMENTING");
      expect(result.to).toBe("VERIFYING");
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
    expect(canTransitionTaskStatus("IMPLEMENTING", "DONE")).toBe(false);
    expect(canTransitionTaskStatus("IMPLEMENTING", "INTEGRATING")).toBe(false);
    expect(canTransitionTaskStatus("VERIFYING", "DONE")).toBe(false);
  });

  it("rejects reversing and re-entering stages", () => {
    expect(canTransitionTaskStatus("VERIFYING", "IMPLEMENTING")).toBe(false);
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

  it("allows FAILED only to converge to DONE through crash recovery", () => {
    for (const to of TASK_STATUSES) {
      expect(canTransitionTaskStatus("FAILED", to)).toBe(to === "DONE");
    }
  });

  it("rejects every transition out of states unsupported by VS003", () => {
    for (const from of UNSUPPORTED_STATES) {
      for (const to of TASK_STATUSES) {
        expect(canTransitionTaskStatus(from, to)).toBe(false);
      }
    }
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

describe("assertTaskTransition", () => {
  it("does not throw for valid transitions", () => {
    expect(() => assertTaskTransition("READY", "IMPLEMENTING")).not.toThrow();
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
    expect(() => assertTaskTransition("PLANNING", "IMPLEMENTING")).toThrow(
      TaskTransitionError,
    );
    expect(() => assertTaskTransition("BACKLOG", "READY")).toThrow(
      TaskTransitionError,
    );
  });
});
