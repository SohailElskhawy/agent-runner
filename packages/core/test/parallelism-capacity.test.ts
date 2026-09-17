import { describe, expect, it } from "vitest";
import type { TaskStatus } from "../src/domain/task-status.js";
import { TASK_STATUSES } from "../src/domain/task-status.js";
import {
  PARALLELISM_ACTIVE_STATUSES,
  ParallelismCapacityError,
  countParallelismActiveExecutions,
  evaluateParallelismCapacity,
  isParallelismActiveStatus,
} from "../src/domain/parallelism-capacity.js";

describe("parallelism capacity policy (M065a)", () => {
  describe("evaluateParallelismCapacity", () => {
    it("reports capacity available with one free slot when max is 1 and none are active", () => {
      expect(
        evaluateParallelismCapacity({ maxParallelism: 1, activeExecutions: 0 }),
      ).toEqual({
        status: "available",
        maxParallelism: 1,
        activeExecutions: 0,
        remainingSlots: 1,
      });
    });

    it("reports capacity exhausted when max is 1 and one execution is active", () => {
      expect(
        evaluateParallelismCapacity({ maxParallelism: 1, activeExecutions: 1 }),
      ).toEqual({
        status: "exhausted",
        maxParallelism: 1,
        activeExecutions: 1,
        remainingSlots: 0,
      });
    });

    it("reports the remaining slots for max 3 with one or two active executions", () => {
      expect(
        evaluateParallelismCapacity({ maxParallelism: 3, activeExecutions: 1 }),
      ).toEqual({
        status: "available",
        maxParallelism: 3,
        activeExecutions: 1,
        remainingSlots: 2,
      });
      expect(
        evaluateParallelismCapacity({ maxParallelism: 3, activeExecutions: 2 }),
      ).toEqual({
        status: "available",
        maxParallelism: 3,
        activeExecutions: 2,
        remainingSlots: 1,
      });
    });

    it("reports capacity exhausted exactly at the maximum", () => {
      expect(
        evaluateParallelismCapacity({ maxParallelism: 3, activeExecutions: 3 }),
      ).toEqual({
        status: "exhausted",
        maxParallelism: 3,
        activeExecutions: 3,
        remainingSlots: 0,
      });
    });

    it("fails safe to exhausted without negative slots when more than max are active", () => {
      expect(
        evaluateParallelismCapacity({ maxParallelism: 2, activeExecutions: 5 }),
      ).toEqual({
        status: "exhausted",
        maxParallelism: 2,
        activeExecutions: 5,
        remainingSlots: 0,
      });
    });

    it("rejects invalid maximums without silent normalization", () => {
      for (const invalid of [0, -1, -100, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() =>
          evaluateParallelismCapacity({ maxParallelism: invalid, activeExecutions: 0 }),
        ).toThrow(ParallelismCapacityError);
      }
      expect(() =>
        evaluateParallelismCapacity({
          maxParallelism: "3" as unknown as number,
          activeExecutions: 0,
        }),
      ).toThrow(ParallelismCapacityError);
    });

    it("rejects invalid active execution counts", () => {
      expect(() =>
        evaluateParallelismCapacity({ maxParallelism: 3, activeExecutions: -1 }),
      ).toThrow(ParallelismCapacityError);
      expect(() =>
        evaluateParallelismCapacity({ maxParallelism: 3, activeExecutions: 1.5 }),
      ).toThrow(ParallelismCapacityError);
    });

    it("evaluates identically on repeated invocation", () => {
      const first = evaluateParallelismCapacity({
        maxParallelism: 4,
        activeExecutions: 2,
      });
      const second = evaluateParallelismCapacity({
        maxParallelism: 4,
        activeExecutions: 2,
      });
      expect(first).toEqual(second);
      expect(second).toEqual({
        status: "available",
        maxParallelism: 4,
        activeExecutions: 2,
        remainingSlots: 2,
      });
    });
  });

  describe("active status classification", () => {
    it("counts only active statuses among provided statuses", () => {
      expect(
        countParallelismActiveExecutions([
          "READY",
          "PLANNING",
          "FAILED",
          "IMPLEMENTING",
          "DONE",
          "CANCELLED",
        ]),
      ).toBe(2);
      expect(countParallelismActiveExecutions([])).toBe(0);
    });

    it("excludes inactive statuses from consuming a slot", () => {
      for (const inactive of [
        "BACKLOG",
        "READY",
        "DONE",
        "BLOCKED",
        "NEEDS_HUMAN",
        "FAILED",
        "CANCELLED",
      ] as const) {
        expect(
          evaluateParallelismCapacity({
            maxParallelism: 1,
            activeExecutions: countParallelismActiveExecutions([inactive]),
          }).status,
        ).toBe("available");
        expect(isParallelismActiveStatus(inactive as TaskStatus)).toBe(false);
      }
    });

    it("classifies every authoritative active workflow status as active", () => {
      expect(PARALLELISM_ACTIVE_STATUSES).toEqual([
        "PLANNING",
        "PLAN_REVIEW",
        "IMPLEMENTING",
        "CODE_REVIEW",
        "VERIFYING",
        "INTEGRATING",
      ]);
      for (const active of PARALLELISM_ACTIVE_STATUSES) {
        expect(isParallelismActiveStatus(active)).toBe(true);
        expect(
          evaluateParallelismCapacity({
            maxParallelism: 1,
            activeExecutions: countParallelismActiveExecutions([active]),
          }).status,
        ).toBe("exhausted");
      }
      expect(
        PARALLELISM_ACTIVE_STATUSES.every((status) =>
          (TASK_STATUSES as readonly string[]).includes(status),
        ),
      ).toBe(true);
    });
  });
});
