import { describe, expect, it } from "vitest";
import {
  INVOCATION_USAGE_SCHEMA_VERSION,
  INVOCATION_USAGE_STATUSES,
  isInvocationUsageObservation,
  parseInvocationUsageObservation,
  type InvocationUsageObservation,
} from "@agentic-dev-runner/core";

const MAX_SAFE_TOKENS = Number.MAX_SAFE_INTEGER;

const unknownOnly: InvocationUsageObservation = {
  schemaVersion: INVOCATION_USAGE_SCHEMA_VERSION,
  status: "unknown",
};

const partialInput: InvocationUsageObservation = {
  schemaVersion: INVOCATION_USAGE_SCHEMA_VERSION,
  status: "partial",
  counters: { inputTokens: 12 },
};

const completeReport: InvocationUsageObservation = {
  schemaVersion: INVOCATION_USAGE_SCHEMA_VERSION,
  status: "complete",
  counters: {
    inputTokens: 12,
    outputTokens: 4,
    reasoningTokens: 1,
    cacheReadTokens: 2,
    cacheWriteTokens: 0,
  },
  cacheRelation: "independent",
};

const inconsistentReport: InvocationUsageObservation = {
  schemaVersion: INVOCATION_USAGE_SCHEMA_VERSION,
  status: "inconsistent",
  counters: { inputTokens: 12, outputTokens: 4, totalTokens: 3 },
  inconsistentReasons: ["reported totalTokens is below both components"],
};

const providerCostReport: InvocationUsageObservation = {
  schemaVersion: INVOCATION_USAGE_SCHEMA_VERSION,
  status: "partial",
  counters: { inputTokens: 12, outputTokens: 4 },
  cost: {
    amount: "0.0000013000",
    currency: "CHF",
    provenance: {
      source: "synthetic-fixture-contract",
      scope: "invocation",
    },
  },
};

function parse(value: unknown) {
  return parseInvocationUsageObservation(value);
}

describe("invocation usage status set", () => {
  it("declares unknown, partial, complete, and inconsistent statuses", () => {
    expect([...INVOCATION_USAGE_STATUSES]).toEqual([
      "unknown",
      "partial",
      "complete",
      "inconsistent",
    ]);
  });
});

describe("invocation usage observation contract", () => {
  it("accepts an unknown-only observation in which nothing was reported", () => {
    expect(parse(unknownOnly)).toEqual(unknownOnly);
    expect(isInvocationUsageObservation(unknownOnly)).toBe(true);
  });

  it("keeps an omitted counter distinct from an explicitly reported zero", () => {
    const parsed = parse(partialInput);
    expect(parsed).toEqual(partialInput);
    expect(parsed?.counters?.inputTokens).toBe(12);
    expect(parsed?.counters?.outputTokens).toBeUndefined();
  });

  it("preserves an explicitly reported zero", () => {
    const zeroedInput: InvocationUsageObservation = {
      schemaVersion: INVOCATION_USAGE_SCHEMA_VERSION,
      status: "partial",
      counters: { inputTokens: 0 },
    };
    expect(parse(zeroedInput)).toEqual(zeroedInput);
    expect(parse(zeroedInput)?.counters?.inputTokens).toBe(0);
  });

  it("accepts a complete report with distinct counters and a declared cache relation", () => {
    expect(parse(completeReport)).toEqual(completeReport);
    expect(isInvocationUsageObservation(completeReport)).toBe(true);
  });

  it("accepts an inconsistent report that flags the conflicting evidence without discarding it", () => {
    expect(parse(inconsistentReport)).toEqual(inconsistentReport);
    expect(isInvocationUsageObservation(inconsistentReport)).toBe(true);
  });

  it("passes a provider-reported cost amount and currency through verbatim without inventing USD or prices", () => {
    const parsed = parse(providerCostReport);
    expect(parsed).toEqual(providerCostReport);
    expect(parsed?.cost?.currency).toBe("CHF");
    expect(parsed?.cost?.amount).toBe("0.0000013000");
    expect(parsed?.cost?.provenance.source).toBe("synthetic-fixture-contract");
    expect(parsed?.cost?.provenance.scope).toBe("invocation");
  });

  it("round-trips every accepted observation through JSON without transformation", () => {
    const observations = [
      unknownOnly,
      partialInput,
      completeReport,
      inconsistentReport,
      providerCostReport,
    ];
    for (const observation of observations) {
      const restored = JSON.parse(
        JSON.stringify(observation),
      ) as InvocationUsageObservation;
      expect(restored).toEqual(observation);
      expect(parse(restored)).toEqual(observation);
    }
  });
});

describe("invocation usage observation validation rejects malformed evidence safely", () => {
  it("returns null and never throws for non-object or missing values", () => {
    expect(() => parse(undefined)).not.toThrow();
    expect(parse(undefined)).toBeNull();
    expect(parse(null)).toBeNull();
    expect(parse("provider said 12 tokens")).toBeNull();
    expect(parse(42)).toBeNull();
    expect(parse([])).toBeNull();
  });

  it("rejects unknown statuses", () => {
    const result = parse({
      schemaVersion: INVOCATION_USAGE_SCHEMA_VERSION,
      status: "estimated",
    });
    expect(result).toBeNull();
  });

  it("rejects future schema versions instead of guessing", () => {
    expect(
      parse({ ...completeReport, schemaVersion: 2 }),
    ).toBeNull();
    expect(
      parse({ ...unknownOnly, schemaVersion: "1" }),
    ).toBeNull();
  });

  it("rejects malformed counter types and values", () => {
    const order = (
      counters: Record<string, unknown>,
    ): unknown => ({ ...unknownOnly, status: "partial", counters });
    expect(parse(order({ inputTokens: -5 }))).toBeNull();
    expect(parse(order({ inputTokens: 1.5 }))).toBeNull();
    expect(parse(order({ inputTokens: "12" }))).toBeNull();
    expect(parse(order({ inputTokens: NaN }))).toBeNull();
    expect(parse(order({ inputTokens: Number.POSITIVE_INFINITY }))).toBeNull();
    expect(parse(order({ inputTokens: MAX_SAFE_TOKENS + 1 }))).toBeNull();
    expect(parse(order({ inputTokens: null }))).toBeNull();
    expect(parse(order({ inputTokens: true }))).toBeNull();
    expect(parse(order({ tokensTotal: 12 }))).toBeNull();
  });

  it("rejects unknown top-level keys so no invented evidence can ride along", () => {
    expect(
      parse({ ...unknownOnly, derivedCost: "0.42" as never }),
    ).toBeNull();
    expect(
      parse({ ...unknownOnly, estimate: { inputTokens: 12 } as never }),
    ).toBeNull();
  });

  it("accepts the exact safe-integer upper bound", () => {
    const bounded: InvocationUsageObservation = {
      schemaVersion: INVOCATION_USAGE_SCHEMA_VERSION,
      status: "partial",
      counters: { inputTokens: MAX_SAFE_TOKENS },
    };
    expect(parse(bounded)).toEqual(bounded);
  });

  it("rejects malformed cache relations", () => {
    const overlapping: InvocationUsageObservation = {
      ...completeReport,
      cacheRelation: "overlapping",
    } as unknown as InvocationUsageObservation;
    expect(parse(overlapping)).toBeNull();
  });

  it("rejects malformed cost shapes and provenance", () => {
    const withoutProvenance = {
      ...providerCostReport,
      cost: {
        amount: "0.42",
        currency: "CHF",
      },
    };
    expect(parse(withoutProvenance)).toBeNull();

    const emptySource = {
      ...providerCostReport,
      cost: {
        ...providerCostReport.cost,
        provenance: { source: "", scope: "invocation" },
      },
    };
    expect(parse(emptySource)).toBeNull();

    const scientificNotation = {
      ...providerCostReport,
      cost: {
        ...providerCostReport.cost,
        amount: "1e5",
      },
    };
    expect(parse(scientificNotation)).toBeNull();

    const negativeAmount = {
      ...providerCostReport,
      cost: {
        ...providerCostReport.cost,
        amount: "-0.42",
      },
    };
    expect(parse(negativeAmount)).toBeNull();

    const numericAmount = {
      ...providerCostReport,
      cost: {
        ...providerCostReport.cost,
        amount: 0.42,
      },
    };
    expect(parse(numericAmount)).toBeNull();

    const blankCurrency = {
      ...providerCostReport,
      cost: {
        ...providerCostReport.cost,
        currency: "",
      },
    };
    expect(parse(blankCurrency)).toBeNull();
  });

  it("rejects estimated/derived metadata keys on cost instead of stripping them", () => {
    const estimatedMetadata = {
      ...providerCostReport,
      cost: {
        ...providerCostReport.cost,
        estimated: true,
        derivedFrom: "tokens",
      },
    };
    expect(parse(estimatedMetadata)).toBeNull();
  });

  it("rejects unknown keys on cost provenance instead of dropping them", () => {
    const catalogKind = {
      ...providerCostReport,
      cost: {
        ...providerCostReport.cost,
        provenance: {
          source: "synthetic-fixture-contract",
          scope: "invocation",
          kind: "catalog",
        },
      },
    };
    expect(parse(catalogKind)).toBeNull();
  });

  it("rejects status/content contradictions instead of repairing them", () => {
    const unknownWithEvidence = {
      ...unknownOnly,
      counters: { inputTokens: 12 },
    };
    expect(parse(unknownWithEvidence)).toBeNull();

    const inconsistentWithoutReasons = {
      ...inconsistentReport,
      inconsistentReasons: undefined,
    };
    expect(parse(inconsistentWithoutReasons)).toBeNull();

    const inconsistentWithEmptyReason = {
      ...inconsistentReport,
      inconsistentReasons: [""],
    };
    expect(parse(inconsistentWithEmptyReason)).toBeNull();

    const completeWithNothing = {
      schemaVersion: INVOCATION_USAGE_SCHEMA_VERSION,
      status: "complete" as const,
    };
    expect(parse(completeWithNothing)).toBeNull();

    const partialWithNothing = {
      schemaVersion: INVOCATION_USAGE_SCHEMA_VERSION,
      status: "partial" as const,
    };
    expect(parse(partialWithNothing)).toBeNull();
  });

  it("rejects unknown status paired with reported evidence", () => {
    const unknownWithCost = {
      ...unknownOnly,
      cost: providerCostReport.cost,
    };
    expect(parse(unknownWithCost)).toBeNull();
  });
});
