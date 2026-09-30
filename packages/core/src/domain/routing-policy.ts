import type { AgentTier } from "./agent-tier.js";
import type { Task } from "./task.js";

const TIER_ORDER: readonly AgentTier[] = ["economy", "standard", "strong"];

export function requiredTierFor(
  task: Pick<Task, "risk"> & { readonly routing: Pick<Task["routing"], "complexity"> },
  priorFailedAttempts: number,
): AgentTier {
  const baseIndex =
    task.risk === "critical" || task.risk === "high" || task.routing.complexity === "large"
      ? 2
      : task.risk === "medium" || task.routing.complexity === "medium"
        ? 1
        : 0;
  const failures = Number.isFinite(priorFailedAttempts)
    ? Math.max(0, Math.floor(priorFailedAttempts))
    : 0;
  return TIER_ORDER[Math.min(2, baseIndex + failures)] ?? "strong";
}
