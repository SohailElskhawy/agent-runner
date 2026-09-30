/** Applies runner-owned defaults to one untrusted planner task record. */
export function normalizePlannedTask(
  raw: Readonly<Record<string, unknown>>,
  milestoneIndex: number | undefined,
  path: string,
  issues: string[],
): Record<string, unknown> {
  const provenanceSource = raw["provenanceSource"];
  if (typeof provenanceSource !== "string" || !provenanceSource.trim()) {
    issues.push(`${path}.provenanceSource: must be a non-empty string`);
  }
  const risk = raw["risk"];
  const highRisk = risk === "high" || risk === "critical";
  const routing = isRecord(raw["routing"]) ? raw["routing"] : {};
  return {
    id: raw["id"],
    title: raw["title"],
    milestone: raw["milestone"],
    status: "READY",
    priority: `P${milestoneIndex ?? 0}`,
    risk,
    type: raw["type"],
    objective: raw["objective"],
    acceptanceCriteria: raw["acceptanceCriteria"],
    dependsOn: raw["dependsOn"],
    provenance: { kind: "roadmap_criterion", source: provenanceSource },
    scope: { allowedPaths: raw["allowedPaths"], forbiddenPaths: [] },
    resources: raw["resources"],
    workflow: risk === "low" ? "simple" : highRisk ? "security-critical" : "default",
    routing,
    verification: { required: raw["verification"] },
    limits: { maxAttempts: 3, maxReviewCycles: 2 },
    approval: { required: highRisk, ...(highRisk ? { reason: "High or critical risk task" } : {}) },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
