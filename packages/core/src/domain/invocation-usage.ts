/**
 * Neutral, provider-independent invocation usage observation contract (D-AP-6
 * slice 1). This module only defines what a provider reported for one runner
 * invocation and how the evidence is validated. It never derives, estimates or
 * infers anything: absent usage stays unknown (never zero), explicit zeros are
 * preserved, partial reports stay partial, contradictory evidence stays
 * inconsistent, and monetary amounts are passed through verbatim with their
 * provider-reported currency and provenance.
 *
 * This is a contract slice only: persistence, invocation wiring, adapter
 * parsing and CLI rendering belong to later slices (AR040+).
 */

export const INVOCATION_USAGE_SCHEMA_VERSION = 1;

/**
 * Well-formedness of one invocation's reported evidence:
 * - `unknown`: nothing usable was reported (no result, missing report,
 *   crash gap, unusable output). Unknown is never zero.
 * - `partial`: some evidence was reported but coverage is incomplete.
 * - `complete`: the caller asserts this is the full usage for the invocation.
 * - `inconsistent`: reported values contradict each other; the conflicting
 *   evidence is retained and reasons are required, nothing is repaired.
 */
export const INVOCATION_USAGE_STATUSES = [
  "unknown",
  "partial",
  "complete",
  "inconsistent",
] as const;

export type InvocationUsageStatus = (typeof INVOCATION_USAGE_STATUSES)[number];

/**
 * Interprets cache counters relative to the other counters. Absent means no
 * claim could be established; never assumed either way.
 */
export const INVOCATION_CACHE_RELATIONS = ["subset", "independent"] as const;

export type InvocationCacheRelation =
  (typeof INVOCATION_CACHE_RELATIONS)[number];

/**
 * Distinct, independently optional counters. Omitted differs from an
 * explicitly reported zero; every present value is a nonnegative safe
 * integer. Cache counters are labelled separately and never merged into
 * input. `totalTokens` is accepted as a distinct provider-reported counter
 * only; it is never used to derive anything.
 */
export type InvocationUsageCounters = {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly totalTokens?: number;
};

/**
 * Exact provider-reported money: exact decimal string (no scientific
 * notation, no binary float), the reported currency as-is, and provenance
 * naming where the amount came from. Nothing here is invented, converted,
 * priced or summed at this layer.
 */
export type InvocationReportedCost = {
  readonly amount: string;
  readonly currency: string;
  readonly provenance: InvocationCostProvenance;
};

export type InvocationCostProvenance = {
  readonly source: string;
  readonly scope: string;
};

export type InvocationUsageObservation = {
  readonly schemaVersion: typeof INVOCATION_USAGE_SCHEMA_VERSION;
  readonly status: InvocationUsageStatus;
  readonly counters?: InvocationUsageCounters;
  readonly cacheRelation?: InvocationCacheRelation;
  readonly cost?: InvocationReportedCost;
  readonly inconsistentReasons?: readonly string[];
};

const USAGE_STATUSES: ReadonlySet<string> = new Set(INVOCATION_USAGE_STATUSES);
const CACHE_RELATIONS: ReadonlySet<string> = new Set(INVOCATION_CACHE_RELATIONS);
const COUNTER_KEYS: ReadonlySet<string> = new Set([
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "totalTokens",
]);
const OBSERVATION_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "status",
  "counters",
  "cacheRelation",
  "cost",
  "inconsistentReasons",
]);
const COST_KEYS: ReadonlySet<string> = new Set([
  "amount",
  "currency",
  "provenance",
]);
const PROVENANCE_KEYS: ReadonlySet<string> = new Set(["source", "scope"]);

/** Maximum accepted value for every counter (safe integer bound). */
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;

/** Exact, nonnegative decimal amounts only; rejects "1e5", "-0.42", numbers. */
const DECIMAL_AMOUNT_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

/**
 * Validates untrusted evidence into an observation. Returns null for any
 * malformed, contradictory or future-version value and never throws: missing
 * optional fields are rejected safely by returning null, while present
 * numeric fields must match the strict shape exactly.
 */
export function parseInvocationUsageObservation(
  value: unknown,
): InvocationUsageObservation | null {
  if (!isRecord(value)) return null;
  for (const key of Object.keys(value)) {
    if (!OBSERVATION_KEYS.has(key)) return null;
  }
  if (value["schemaVersion"] !== INVOCATION_USAGE_SCHEMA_VERSION) return null;
  if (typeof value["status"] !== "string" || !USAGE_STATUSES.has(value["status"])) {
    return null;
  }
  const status = value["status"] as InvocationUsageStatus;
  const counters = parseCounters(value["counters"]);
  const cacheRelation = parseCacheRelation(value["cacheRelation"]);
  const cost = parseCost(value["cost"]);
  const reasons = parseReasons(value["inconsistentReasons"]);
  if (
    counters === null ||
    cacheRelation === null ||
    cost === null ||
    reasons === null
  ) {
    return null;
  }
  if (!statusSupportsContent(status, counters, cost, reasons)) return null;
  return {
    schemaVersion: INVOCATION_USAGE_SCHEMA_VERSION,
    status,
    ...(counters === undefined ? {} : { counters }),
    ...(cacheRelation === undefined ? {} : { cacheRelation }),
    ...(cost === undefined ? {} : { cost }),
    ...(reasons === undefined ? {} : { inconsistentReasons: reasons }),
  };
}

/** Type guard backed by the same strict validation. */
export function isInvocationUsageObservation(
  value: unknown,
): value is InvocationUsageObservation {
  return parseInvocationUsageObservation(value) !== null;
}

/**
 * Status/content consistency rules (never repaired):
 * - `unknown` carries no evidence at all: any reported value contradicts it.
 * - `partial` requires at least one reported counter or cost.
 * - `complete` requires reported counters; cost alone cannot claim token
 *   coverage.
 * - `inconsistent` requires at least one reason; evidence may be retained.
 */
function statusSupportsContent(
  status: InvocationUsageStatus,
  counters: InvocationUsageCounters | undefined,
  cost: InvocationReportedCost | undefined,
  reasons: readonly string[] | undefined,
): boolean {
  switch (status) {
    case "unknown":
      return counters === undefined && cost === undefined && reasons === undefined;
    case "partial":
      return (counters !== undefined && Object.keys(counters).length > 0) || cost !== undefined;
    case "complete":
      return counters !== undefined && Object.keys(counters).length > 0;
    case "inconsistent":
      return reasons !== undefined;
  }
}

function parseCounters(
  value: unknown,
): InvocationUsageCounters | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const parsed: Record<string, number> = {};
  for (const key of Object.keys(value)) {
    if (!COUNTER_KEYS.has(key)) return null;
    const count: unknown = value[key];
    if (
      typeof count !== "number" ||
      !Number.isInteger(count) ||
      count < 0 ||
      count > MAX_COUNTER
    ) {
      return null;
    }
    parsed[key] = count;
  }
  return parsed;
}

function parseCacheRelation(
  value: unknown,
): InvocationCacheRelation | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value === "string" && CACHE_RELATIONS.has(value)) {
    return value as InvocationCacheRelation;
  }
  return null;
}

function parseReasons(value: unknown): readonly string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) return null;
  const reasons: string[] = [];
  for (const reason of value) {
    if (typeof reason !== "string" || !reason.trim()) return null;
    reasons.push(reason);
  }
  return reasons;
}

function parseCost(value: unknown): InvocationReportedCost | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  for (const key of Object.keys(value)) {
    if (!COST_KEYS.has(key)) return null;
  }
  const amount: unknown = value["amount"];
  if (typeof amount !== "string" || !DECIMAL_AMOUNT_PATTERN.test(amount)) {
    return null;
  }
  const currency: unknown = value["currency"];
  if (typeof currency !== "string" || !currency.trim()) return null;
  const provenance: unknown = value["provenance"];
  if (!isRecord(provenance)) return null;
  for (const key of Object.keys(provenance)) {
    if (!PROVENANCE_KEYS.has(key)) return null;
  }
  const source: unknown = provenance["source"];
  const scope: unknown = provenance["scope"];
  if (
    typeof source !== "string" ||
    !source.trim() ||
    typeof scope !== "string" ||
    !scope.trim()
  ) {
    return null;
  }
  return {
    amount,
    currency,
    provenance: { source, scope },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
