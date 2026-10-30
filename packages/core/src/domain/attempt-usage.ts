import type { Attempt, AttemptExecutionMode } from "./attempt.js";
import type { StageRun } from "./stage-run.js";
import {
  parseInvocationUsageObservation,
  type InvocationUsageCounters,
  type InvocationUsageObservation,
  type InvocationReportedCost,
  type InvocationUsageStatus,
} from "./invocation-usage.js";

type Identity = {
  readonly kind: "attempt" | "stage";
  readonly id: string;
};
type Evidence = {
  readonly identity: Identity;
  readonly observation?: InvocationUsageObservation;
  readonly stage?: Pick<StageRun, "attemptId" | "stage" | "status">;
};
type Counter = {
  readonly status: InvocationUsageStatus;
  readonly possible: number;
  readonly reported: number;
  readonly subtotal?: number;
  readonly reasons: readonly string[];
};
export type AttemptUsageSummary = {
  readonly mode: AttemptExecutionMode | "unknown";
  readonly status: InvocationUsageStatus;
  readonly reasons: readonly string[];
  readonly possible: number;
  readonly known: number;
  readonly invocations: readonly Evidence[];
  readonly counters: Readonly<Record<keyof InvocationUsageCounters, Counter>>;
  readonly costs: readonly {
    readonly identity: Identity;
    readonly cost: InvocationReportedCost;
  }[];
  readonly exclusions: readonly [
    "project planning",
    "VERIFY",
    "INTEGRATE"
  ];
};
const counterKeys = ["inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"] as const;

const agentStages = new Set(["PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW"]);

function canonical(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function checked(value: InvocationUsageObservation): InvocationUsageObservation {
  const observation = parseInvocationUsageObservation(value);
  if (observation === null)
    throw new Error("Invalid invocation usage observation");
  return observation;
}

export function deriveAttemptUsage(
  attempt: Attempt,
  stageRuns: readonly StageRun[],
): AttemptUsageSummary {
  const mode = attempt.executionMode ?? "unknown";
  const relevant = stageRuns.filter(
    (stage) => stage.attemptId === attempt.id && agentStages.has(stage.stage),
  );
  const foreign = stageRuns.some((stage) => stage.attemptId !== attempt.id);
  const groups = [...new Set(relevant.map((stage) => stage.id))].map((id) =>
    relevant.filter((stage) => stage.id === id),
  );
  const conflict = groups.some((group) => new Set(group.map(canonical)).size > 1);
  const modeConflict =
    (mode === "single-task" && relevant.length > 0) ||
    (mode === "workflow" && attempt.invocationUsage !== undefined) ||
    (mode === "unknown" && attempt.invocationUsage !== undefined && relevant.length > 0);
  const stages = groups.flatMap((group) =>
    [...new Map(group.map((row) => [canonical(row), row])).values()].map((row): Evidence => ({
      identity: { kind: "stage", id: row.id },
      stage: { attemptId: row.attemptId, stage: row.stage, status: row.status },
      ...(row.usage === undefined ? {} : { observation: checked(row.usage) }),
    })),
  );
  const single: Evidence[] = mode === "single-task" || attempt.invocationUsage !== undefined
    ? [{
      identity: { kind: "attempt", id: attempt.id },
      ...(attempt.invocationUsage === undefined ? {} : { observation: checked(attempt.invocationUsage) }),
    }]
    : [];
  const invocations = [...single, ...stages];
  const possible = (single.length > 0 ? 1 : 0) + groups.length;
  const known =
    (single.some((entry) => entry.observation !== undefined && entry.observation.status !== "unknown") ? 1 : 0) +
    groups.filter((group) => group.some((row) => row.usage !== undefined && row.usage.status !== "unknown")).length;
  const invalid = foreign || conflict || modeConflict || invocations.some((entry) => entry.observation?.status === "inconsistent");
  const reasons = [
    ...(foreign ? ["Stage ownership does not match attempt"] : []),
    ...(conflict ? ["Conflicting records share a stage identity"] : []),
    ...(modeConflict ? ["Execution mode conflicts with invocation evidence"] : []),
    ...(mode === "unknown" ? ["Execution mode is unknown"] : []),
    ...(attempt.status === "RUNNING" ? ["Running attempt may have future invocations"] : []),
    ...(possible === 0 ? ["No possible invocation is recorded"] : []),
    ...(invocations.some((entry) => entry.observation === undefined || entry.observation.status === "unknown") ? ["Some invocation usage is unknown"] : []),
    ...(invocations.some((entry) => entry.observation?.status === "partial") ? ["Some invocation usage is partial"] : []),
    ...invocations.flatMap((entry) => entry.observation?.inconsistentReasons ?? []),
  ];
  const open = mode === "unknown" || attempt.status === "RUNNING" || possible === 0;
  const status: InvocationUsageStatus = invalid ? "inconsistent" : known === 0 ? "unknown" : open || invocations.some((entry) => entry.observation?.status !== "complete") ? "partial" : "complete";
  const counterFor = (key: keyof InvocationUsageCounters): Counter => {
    const contributors = invocations.filter((entry) => entry.observation?.counters?.[key] !== undefined);
    const values = contributors.map((entry) => entry.observation?.counters?.[key] ?? 0);
    const cache = key === "cacheReadTokens" || key === "cacheWriteTokens";
    const relations = new Set(contributors.map((entry) => entry.observation?.cacheRelation));
    const incompatible = cache && contributors.length > 0 && (relations.has(undefined) || relations.size > 1);
    const sum = values.reduce<number | undefined>((total, value) => total === undefined || value > Number.MAX_SAFE_INTEGER - total ? undefined : total + value, 0);
    const bad = invalid || incompatible || sum === undefined;
    const counterReasons = [
      ...(invalid ? ["Invocation evidence is inconsistent"] : []),
      ...(incompatible ? ["Cache relations are missing or incompatible"] : []),
      ...(sum === undefined ? ["Counter subtotal exceeds safe integer range"] : []),
      ...(contributors.length < possible ? ["Counter is not reported for every possible invocation"] : []),
      ...(open ? ["Attempt coverage is incomplete"] : []),
      ...(contributors.some((entry) => entry.observation?.status === "partial") ? ["A contributor is partial"] : []),
    ];
    const counterStatus: InvocationUsageStatus = bad ? "inconsistent" : contributors.length === 0 ? "unknown" : open || contributors.length < possible || contributors.some((entry) => entry.observation?.status !== "complete") ? "partial" : "complete";
    return { status: counterStatus, possible, reported: contributors.length, ...(!bad && contributors.length > 0 && sum !== undefined ? { subtotal: sum } : {}), reasons: counterReasons };
  };
  const counters: AttemptUsageSummary["counters"] = {
    inputTokens: counterFor("inputTokens"), outputTokens: counterFor("outputTokens"),
    reasoningTokens: counterFor("reasoningTokens"), cacheReadTokens: counterFor("cacheReadTokens"),
    cacheWriteTokens: counterFor("cacheWriteTokens"), totalTokens: counterFor("totalTokens"),
  };
  const costs = invocations.flatMap((entry) => entry.observation?.cost === undefined ? [] : [{ identity: entry.identity, cost: entry.observation.cost }]);
  const aggregateErrors = counterKeys.flatMap((key) => counters[key].status === "inconsistent" && !invalid ? counters[key].reasons.map((reason) => `${key}: ${reason}`) : []);
  return { mode, status: aggregateErrors.length > 0 ? "inconsistent" : status, reasons: [...reasons, ...aggregateErrors], possible, known, invocations, counters, costs, exclusions: ["project planning", "VERIFY", "INTEGRATE"] };
}
