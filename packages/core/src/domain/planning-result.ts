export type PlanningQuestion = {
  readonly id: string;
  readonly prompt: string;
  readonly reason: string;
  readonly importance: "important" | "low-risk";
  readonly choices: readonly string[];
};

export type PlanningMilestone = {
  readonly id: string;
  readonly title: string;
  readonly completionCriteria: readonly string[];
};

export type PlanningResult =
  | { readonly version: 1; readonly kind: "NEEDS_DISCOVERY"; readonly questions: readonly PlanningQuestion[] }
  | { readonly version: 1; readonly kind: "READY_FOR_PLANNING"; readonly milestones: readonly PlanningMilestone[]; readonly tasks: readonly Readonly<Record<string, unknown>>[] };

export type PlanningResultValidation =
  | { readonly ok: true; readonly value: PlanningResult }
  | { readonly ok: false; readonly issues: readonly string[] };

export function parsePlanningResult(value: unknown): PlanningResultValidation {
  const issues: string[] = [];
  if (!isRecord(value)) return { ok: false, issues: ["planning result: must be an object"] };
  if (value["version"] !== 1) issues.push("planning result.version: must be 1");
  if (value["kind"] === "NEEDS_DISCOVERY") {
    const questions: PlanningQuestion[] = [];
    if (!Array.isArray(value["questions"])) issues.push("planning result.questions: must be an array");
    else {
      if (value["questions"].length === 0) issues.push("planning result.questions: must contain at least one question");
      value["questions"].forEach((item: unknown, index: number) => {
        const path = `planning result.questions[${index}]`;
        if (!isRecord(item)) { issues.push(`${path}: must be an object`); return; }
        const id = nonEmpty(item["id"], `${path}.id`, issues);
        const prompt = nonEmpty(item["prompt"], `${path}.prompt`, issues);
        const reason = nonEmpty(item["reason"], `${path}.reason`, issues);
        const importance = item["importance"];
        if (importance !== "important" && importance !== "low-risk") issues.push(`${path}.importance: must be important or low-risk`);
        const choices = stringList(item["choices"], `${path}.choices`, issues, true);
        if (id !== undefined && prompt !== undefined && reason !== undefined && (importance === "important" || importance === "low-risk") && choices !== undefined) {
          questions.push({ id, prompt, reason, importance, choices });
        }
      });
    }
    return issues.length ? { ok: false, issues } : { ok: true, value: { version: 1, kind: "NEEDS_DISCOVERY", questions } };
  }
  if (value["kind"] === "READY_FOR_PLANNING") {
    const milestones: PlanningMilestone[] = [];
    if (!Array.isArray(value["milestones"]) || value["milestones"].length === 0) issues.push("planning result.milestones: must be a non-empty array");
    else value["milestones"].forEach((item: unknown, index: number) => {
      const path = `planning result.milestones[${index}]`;
      if (!isRecord(item)) { issues.push(`${path}: must be an object`); return; }
      const id = nonEmpty(item["id"], `${path}.id`, issues);
      const title = nonEmpty(item["title"], `${path}.title`, issues);
      const completionCriteria = stringList(item["completionCriteria"], `${path}.completionCriteria`, issues, true);
      if (id !== undefined && title !== undefined && completionCriteria !== undefined) milestones.push({ id, title, completionCriteria });
    });
    const tasks: Readonly<Record<string, unknown>>[] = [];
    if (!Array.isArray(value["tasks"]) || value["tasks"].length === 0) issues.push("planning result.tasks: must be a non-empty array");
    else value["tasks"].forEach((item: unknown, index: number) => {
      if (!isRecord(item)) issues.push(`planning result.tasks[${index}]: must be an object`);
      else tasks.push(item);
    });
    return issues.length ? { ok: false, issues } : { ok: true, value: { version: 1, kind: "READY_FOR_PLANNING", milestones, tasks } };
  }
  issues.push("planning result.kind: must be NEEDS_DISCOVERY or READY_FOR_PLANNING");
  return { ok: false, issues };
}

function nonEmpty(value: unknown, path: string, issues: string[]): string | undefined {
  if (typeof value !== "string" || !value.trim()) { issues.push(`${path}: must be a non-empty string`); return undefined; }
  return value;
}

function stringList(value: unknown, path: string, issues: string[], nonEmptyList: boolean): readonly string[] | undefined {
  if (!Array.isArray(value)) { issues.push(`${path}: must be an array of strings`); return undefined; }
  if (nonEmptyList && value.length === 0) issues.push(`${path}: must contain at least one item`);
  const parsed: string[] = [];
  value.forEach((entry: unknown, index: number) => {
    const item = nonEmpty(entry, `${path}[${index}]`, issues);
    if (item !== undefined) parsed.push(item);
  });
  return parsed.length === value.length && (!nonEmptyList || parsed.length > 0) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
