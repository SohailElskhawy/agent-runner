import { describe, expect, it } from "vitest";
import { deriveAttemptUsage, type Attempt, type StageRun, type InvocationUsageObservation } from "../src/index.js";

const attempt: Attempt = { id: "a", taskId: "t", number: 1, status: "SUCCEEDED", executionMode: "workflow", agent: "agent", baseRevision: "rev", startedAt: "2026-01-01T00:00:00Z" };
const usage: InvocationUsageObservation = { schemaVersion: 1, status: "complete", counters: { inputTokens: 0, outputTokens: 3 } };
const stage = (id: string, evidence: InvocationUsageObservation | undefined = usage): StageRun => ({ id, attemptId: "a", stage: "IMPLEMENT", status: "SUCCEEDED", ...(evidence === undefined ? {} : { usage: evidence }) });

describe("attempt usage", () => {
  it("distinguishes missing coverage, zero and open attempts", () => {
    expect(deriveAttemptUsage(attempt, []).status).toBe("unknown");
    const result = deriveAttemptUsage(attempt, [stage("1")]);
    expect(result.status).toBe("complete");
    expect(result.counters.inputTokens).toMatchObject({ subtotal: 0, reported: 1, possible: 1, status: "complete" });
    expect(result.counters.totalTokens).toMatchObject({ reported: 0, possible: 1, status: "unknown" });
    expect(deriveAttemptUsage({ ...attempt, status: "RUNNING" }, [stage("1")]).status).toBe("partial");
    const legacy: Attempt = { id: "a", taskId: "t", number: 1, status: "FAILED", agent: "agent", baseRevision: "rev", startedAt: "2026-01-01T00:00:00Z" };
    expect(deriveAttemptUsage(legacy, []).status).toBe("unknown");
    expect(deriveAttemptUsage(legacy, [stage("1")]).status).toBe("partial");
  });
  it("deduplicates replay, rejects conflicts and foreign rows", () => {
    expect(deriveAttemptUsage(attempt, [stage("1"), stage("1")]).counters.outputTokens.subtotal).toBe(3);
    const conflict = deriveAttemptUsage(attempt, [stage("1"), stage("1", { ...usage, counters: { outputTokens: 4 } })]);
    expect(conflict.status).toBe("inconsistent");
    expect(conflict.invocations.map((entry) => entry.observation?.counters?.outputTokens)).toEqual([3, 4]);
    expect(conflict.counters.outputTokens.subtotal).toBeUndefined();
    expect(conflict.reasons.join()).toContain("Conflicting");
    const foreign = deriveAttemptUsage(attempt, [{ ...stage("2"), attemptId: "foreign" }]);
    expect(foreign.status).toBe("inconsistent");
    expect(foreign.invocations).toEqual([]);
  });
});

describe("conservative evidence", () => {
  it("handles single-task, missing results, retries, cycles and exclusions", () => {
    const single = { ...attempt, executionMode: "single-task" as const, status: "FAILED" as const };
    expect(deriveAttemptUsage(single, []).invocations[0]?.identity).toEqual({ kind: "attempt", id: "a" });
    expect(deriveAttemptUsage(single, []).status).toBe("unknown");
    expect(deriveAttemptUsage({ ...single, invocationUsage: usage }, []).status).toBe("complete");
    expect(deriveAttemptUsage({ ...single, invocationUsage: { schemaVersion: 1, status: "unknown" } }, []).status).toBe("unknown");
    expect(deriveAttemptUsage(single, [stage("s")]).status).toBe("inconsistent");
    const result = deriveAttemptUsage(attempt, [{ ...stage("review-1"), stage: "CODE_REVIEW" }, { ...stage("review-2"), stage: "CODE_REVIEW" }, { ...stage("verify"), stage: "VERIFY" }, { ...stage("integrate"), stage: "INTEGRATE" }]);
    expect(result.possible).toBe(2);
    expect(result.counters.outputTokens.subtotal).toBe(6);
    expect(deriveAttemptUsage({ ...attempt, id: "retry" }, [stage("review-1")]).status).toBe("inconsistent");
    const missing: StageRun = { id: "missing", attemptId: "a", stage: "IMPLEMENT", status: "FAILED" };
    expect(deriveAttemptUsage(attempt, [missing]).status).toBe("unknown");
  });
  it("tracks each counter and partial or inconsistent evidence independently", () => {
    const partial: InvocationUsageObservation = { schemaVersion: 1, status: "partial", counters: { outputTokens: 0 } };
    const result = deriveAttemptUsage(attempt, [stage("a"), stage("b", partial)]);
    expect(result.status).toBe("partial");
    expect(result.counters.inputTokens).toMatchObject({ status: "partial", subtotal: 0, possible: 2, reported: 1 });
    expect(result.counters.outputTokens).toMatchObject({ status: "partial", subtotal: 3, reported: 2 });
    const inconsistent: InvocationUsageObservation = { schemaVersion: 1, status: "inconsistent", counters: { outputTokens: 8 }, inconsistentReasons: ["contradiction"] };
    const bad = deriveAttemptUsage(attempt, [stage("a", inconsistent)]);
    expect(bad.status).toBe("inconsistent");
    expect(bad.reasons).toContain("contradiction");
    expect(bad.counters.outputTokens.subtotal).toBeUndefined();
  });
  it("checks overflow and cache compatibility without inventing totals", () => {
    const report = (count: number, relation?: "subset" | "independent"): InvocationUsageObservation => ({ schemaVersion: 1, status: "complete", counters: { inputTokens: count, cacheReadTokens: 1 }, ...(relation === undefined ? {} : { cacheRelation: relation }) });
    const overflow = deriveAttemptUsage(attempt, [stage("a", report(Number.MAX_SAFE_INTEGER, "subset")), stage("b", report(1, "subset"))]);
    expect(overflow.status).toBe("inconsistent");
    expect(overflow.counters.inputTokens.reasons.join()).toContain("safe integer");
    expect(overflow.counters.cacheReadTokens.subtotal).toBe(2);
    expect(overflow.counters.totalTokens.subtotal).toBeUndefined();
    for (const relation of [undefined, "independent"] as const) {
      const result = deriveAttemptUsage(attempt, [stage("a", report(1, "subset")), stage("b", report(1, relation))]);
      expect(result.counters.cacheReadTokens.status).toBe("inconsistent");
      expect(result.counters.inputTokens.subtotal).toBe(2);
    }
  });
  it("retains exact money and ignores legacy values", () => {
    const cost = (amount: string, currency: string): InvocationUsageObservation => ({ schemaVersion: 1, status: "partial", cost: { amount, currency, provenance: { source: "test", scope: "invocation" } } });
    const result = deriveAttemptUsage({ ...attempt, tokenUsage: { inputTokens: 99 }, cost: 12 }, [stage("a", cost("0.0000000100", "USD")), stage("b", cost("12345678901234567890.0", "EUR"))]);
    expect(result.costs.map((entry) => entry.cost.amount)).toEqual(["0.0000000100", "12345678901234567890.0"]);
    expect(deriveAttemptUsage(attempt, [stage("a", cost("1.00", "USD")), stage("b", cost("2.0", "USD"))]).costs.map((entry) => entry.cost.amount)).toEqual(["1.00", "2.0"]);
    expect(result.counters.inputTokens.subtotal).toBeUndefined();
    expect(result.status).toBe("partial");
  });
});
