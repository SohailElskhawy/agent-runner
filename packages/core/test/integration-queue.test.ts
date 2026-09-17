import { describe, expect, it } from "vitest";
import type { IntegrationQueueEntry } from "../src/domain/integration-queue.js";
import {
  findActiveIntegrationQueueEntry,
  hasActiveIntegrationQueueEntry,
  isActiveIntegrationQueueStatus,
  orderIntegrationQueueEntries,
  selectNextIntegrationQueueEntry,
} from "../src/domain/integration-queue.js";

function entry(overrides: Partial<IntegrationQueueEntry>): IntegrationQueueEntry {
  return {
    id: "iq_1",
    sequence: 1,
    taskId: "M001",
    attemptId: "att_M001_1",
    taskRevision: "rev_1",
    branch: "task/M001/attempt-1",
    baseRevision: "base_1",
    status: "PENDING",
    enqueuedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("integration queue policy (M047a)", () => {
  describe("orderIntegrationQueueEntries", () => {
    it("orders by enqueue sequence ascending", () => {
      const third = entry({ id: "iq_c", sequence: 3 });
      const first = entry({ id: "iq_a", sequence: 1 });
      const second = entry({ id: "iq_b", sequence: 2 });

      expect(orderIntegrationQueueEntries([third, first, second])).toEqual([
        first,
        second,
        third,
      ]);
    });

    it("breaks sequence ties by entry id ascending", () => {
      const alpha = entry({ id: "iq_a", sequence: 1 });
      const beta = entry({ id: "iq_b", sequence: 1 });
      const gamma = entry({ id: "iq_c", sequence: 1 });

      expect(orderIntegrationQueueEntries([beta, gamma, alpha])).toEqual([
        alpha,
        beta,
        gamma,
      ]);
      expect(orderIntegrationQueueEntries([beta, alpha, gamma])).toEqual([
        alpha,
        beta,
        gamma,
      ]);
    });

    it("is deterministic regardless of input order and repeats identically", () => {
      const entries = [
        entry({ id: "iq_2", sequence: 2, status: "COMPLETED" }),
        entry({ id: "iq_1", sequence: 1, status: "INTEGRATING" }),
        entry({ id: "iq_3", sequence: 3 }),
      ];
      const first = orderIntegrationQueueEntries(entries);
      const second = orderIntegrationQueueEntries([...entries].reverse());
      expect(first).toEqual(second);
      expect(first).toEqual([
        entry({ id: "iq_1", sequence: 1, status: "INTEGRATING" }),
        entry({ id: "iq_2", sequence: 2, status: "COMPLETED" }),
        entry({ id: "iq_3", sequence: 3 }),
      ]);
    });
  });

  describe("selectNextIntegrationQueueEntry", () => {
    it("selects the first pending entry in queue order", () => {
      const older = entry({ id: "iq_1", sequence: 1 });
      const newer = entry({ id: "iq_2", sequence: 2 });

      expect(selectNextIntegrationQueueEntry([newer, older])).toEqual({
        ok: true,
        entry: older,
      });
    });

    it("never selects while an entry is actively integrating", () => {
      const integrating = entry({ id: "iq_1", sequence: 1, status: "INTEGRATING" });
      const pending = entry({ id: "iq_2", sequence: 2 });

      expect(selectNextIntegrationQueueEntry([pending, integrating])).toEqual({
        ok: false,
        reason: "entry-integrating",
      });
    });

    it("reports an empty queue when no pending entry exists", () => {
      expect(
        selectNextIntegrationQueueEntry([
          entry({ id: "iq_1", status: "COMPLETED" }),
          entry({ id: "iq_2", status: "FAILED" }),
        ]),
      ).toEqual({ ok: false, reason: "queue-empty" });
      expect(selectNextIntegrationQueueEntry([])).toEqual({
        ok: false,
        reason: "queue-empty",
      });
    });

    it("settled entries do not block selection", () => {
      const settled = entry({ id: "iq_1", status: "COMPLETED" });
      const pending = entry({ id: "iq_2", sequence: 2 });

      expect(selectNextIntegrationQueueEntry([settled, pending])).toEqual({
        ok: true,
        entry: pending,
      });
    });
  });

  describe("active duplicate detection", () => {
    it("finds the active entry for a task/attempt pair", () => {
      const pending = entry({ id: "iq_1", status: "PENDING" });
      expect(findActiveIntegrationQueueEntry([pending], "M001", "att_M001_1")).toBe(
        pending,
      );
      expect(
        hasActiveIntegrationQueueEntry([pending], "M001", "att_M001_1"),
      ).toBe(true);
    });

    it("ignores completed and failed entries", () => {
      const completed = entry({ id: "iq_1", status: "COMPLETED" });
      const failed = entry({ id: "iq_2", status: "FAILED" });
      expect(
        findActiveIntegrationQueueEntry([completed, failed], "M001", "att_M001_1"),
      ).toBeUndefined();
      expect(
        hasActiveIntegrationQueueEntry([completed, failed], "M001", "att_M001_1"),
      ).toBe(false);
    });

    it("distinguishes attempts of the same task", () => {
      const other = entry({ id: "iq_1", attemptId: "att_M001_2" });
      expect(hasActiveIntegrationQueueEntry([other], "M001", "att_M001_1")).toBe(
        false,
      );
    });
  });

  describe("isActiveIntegrationQueueStatus", () => {
    it("classifies only pending and integrating entries as active", () => {
      expect(isActiveIntegrationQueueStatus("PENDING")).toBe(true);
      expect(isActiveIntegrationQueueStatus("INTEGRATING")).toBe(true);
      expect(isActiveIntegrationQueueStatus("COMPLETED")).toBe(false);
      expect(isActiveIntegrationQueueStatus("FAILED")).toBe(false);
    });
  });
});
