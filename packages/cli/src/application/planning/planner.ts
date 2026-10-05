import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentRuntime } from "@agentic-dev-runner/agents";
import type { AgentProfile, ContextPack, PlanningInput, PlanningQuestion, Task } from "@agentic-dev-runner/core";
import { normalizeAndValidatePlan, parsePlanningResult } from "@agentic-dev-runner/core";
import type { GitManager } from "@agentic-dev-runner/git";
import type { ProcessRunner } from "@agentic-dev-runner/platform";
import { assessReadiness } from "@agentic-dev-runner/core";
import { writeDiscoveryQuestions, writePlanDraft } from "./plan-files.js";

const MAX_INVOCATIONS = 3;

export type PlanningOutcome =
  | { readonly kind: "NEEDS_DISCOVERY"; readonly questions: readonly PlanningQuestion[] }
  | { readonly kind: "READY_FOR_PLANNING"; readonly draft: { readonly planId: string; readonly inputDigest: string } };

export function createRepositoryPlanner(options: {
  readonly git: GitManager;
  readonly runner: ProcessRunner;
  readonly agent: AgentRuntime;
  readonly profile: AgentProfile;
  readonly worktreesDir: string;
  readonly timeoutMs: number;
  readonly configuredVerificationChecks: readonly string[];
}) {
  return async function planRepository(input: PlanningInput): Promise<PlanningOutcome> {
    if (input.baseRevision === "unborn") throw new Error("planning requires an initial Git commit; commit the project seed, then analyze again");
    if (!(await options.git.isRepository(input.repositoryRoot))) throw new Error(`not a Git repository: ${input.repositoryRoot}`);
    if (await options.git.resolveHeadRevision(input.repositoryRoot) !== input.baseRevision) {
      throw new Error("repository HEAD changed after analysis; analyze again before planning");
    }
    const worktreePath = join(options.worktreesDir, `planning-${randomUUID()}`);
    try {
      await mkdir(dirname(worktreePath), { recursive: true });
      const added = await options.runner.run({
        executable: "git", args: ["worktree", "add", "--detach", worktreePath, input.baseRevision], cwd: input.repositoryRoot,
      });
      if (added.outcome.kind !== "completed" || added.outcome.code !== 0) {
        throw new Error(`could not create planner worktree at analyzed revision: ${added.stderr.trim() || added.outcome.kind}`);
      }
      let repair = "";
      for (let attempt = 1; attempt <= MAX_INVOCATIONS; attempt += 1) {
        const response = await invokePlanner(options.agent, options.profile, makeContextPack(input), worktreePath, options.timeoutMs, repair);
        const [status, revision] = await Promise.all([
          options.git.status(worktreePath),
          options.git.resolveHeadRevision(worktreePath),
        ]);
        if (!status.clean || revision !== input.baseRevision) {
          throw new Error("planner modified its isolated worktree; planning responses must be returned as JSON without source edits");
        }
        if (response.kind !== "success") throw new Error(response.reason);
        const parsedJson = parseJson(response.stdout);
        if (!parsedJson.ok) {
          repair = `The previous response was invalid JSON: ${parsedJson.issue}. Return exactly one JSON object matching the PlanningResult version-1 contract; make no file changes.`;
          continue;
        }
        const parsed = parsePlanningResult(parsedJson.value);
        if (!parsed.ok) {
          repair = `The previous PlanningResult was invalid: ${parsed.issues.join("; ")}. Correct it and return only the complete JSON object.`;
          continue;
        }
        if (parsed.value.kind === "NEEDS_DISCOVERY") {
          if (parsed.value.questions.some((question) => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(question.id))) {
            repair = "Every discovery question ID must be a stable token using letters, digits, dots, underscores, or hyphens (maximum 64 characters). Correct the IDs and return only the JSON object.";
            continue;
          }
          const readiness = assessReadiness(parsed.value, input.answeredQuestionIds);
          if (readiness.status === "NEEDS_DISCOVERY") {
            await writeDiscoveryQuestions(input.repositoryRoot, readiness.questions);
            return { kind: "NEEDS_DISCOVERY", questions: readiness.questions };
          }
          repair = "All important discovery questions have recorded answers. Return a READY_FOR_PLANNING result with milestones and tasks now.";
          continue;
        }
        const normalized = normalizeAndValidatePlan(parsed.value, {
          configuredVerificationChecks: options.configuredVerificationChecks,
          existingTaskIds: input.existingTaskIds,
        });
        if (!normalized.ok) {
          repair = `The plan failed runner validation: ${normalized.issues.join("; ")}. Correct the JSON plan and return it without implementation.`;
          continue;
        }
        const draft = await writePlanDraft(input.repositoryRoot, input, parsed.value, normalized.tasks);
        return { kind: "READY_FOR_PLANNING", draft };
      }
      throw new Error("invalid planner response after bounded repair: planner did not return an actionable, valid result");
    } finally {
      const registered = await options.git.worktreeExists(input.repositoryRoot, worktreePath).catch(() => false);
      try {
        if (registered) await options.git.removeWorktree(input.repositoryRoot, worktreePath, { force: true });
      } finally {
        await rm(worktreePath, { recursive: true, force: true });
      }
    }
  };
}

async function invokePlanner(
  agent: AgentRuntime,
  profile: AgentProfile,
  contextPack: ContextPack,
  worktreePath: string,
  timeoutMs: number,
  repair: string,
): Promise<{ readonly kind: "success"; readonly stdout: string } | { readonly kind: "failure"; readonly reason: string }> {
  const result = await agent.invoke({
    agent: { id: profile.adapterId, ...(profile.model === undefined ? {} : { model: profile.model }), capabilities: profile.capabilities },
    contextPack,
    worktreePath,
    timeoutMs,
    readOnly: true,
    instruction: [
      "STAGE PLANNING — return a provider-independent PlanningResult JSON object, version 1.",
      'For NEEDS_DISCOVERY use {"version":1,"kind":"NEEDS_DISCOVERY","questions":[{"id":"Q1","prompt":"...","reason":"...","importance":"important","choices":["..."]}]}.',
      'For READY_FOR_PLANNING use {"version":1,"kind":"READY_FOR_PLANNING","milestones":[{"id":"M1","title":"...","completionCriteria":["..."]}],"tasks":[{"id":"T1","title":"...","milestone":"M1","objective":"...","acceptanceCriteria":["..."],"dependsOn":[],"provenanceSource":"docs/PROJECT_SPEC.md","allowedPaths":["src/**"],"risk":"low","type":"implementation","resources":[],"routing":{"complexity":"small","capabilities":[]},"verification":[]}]} .',
      "Return exactly one JSON object. Tasks use flat fields; do not wrap milestones or tasks in another object or put task fields under definition. Use only configured verification check names.",
      "Treat the supplied PlanningInput as authoritative. Use read-only file access to read the supplied context pack, including cat if needed. Do not run Git or commands that modify files. Do not create, modify, or delete files; do not implement source code.",
      repair,
    ].filter(Boolean).join(" "),
  });
  if (result.kind !== "success") {
    const reason = result.kind === "failure" ? result.failure.message : `planner ${result.kind}`;
    return { kind: "failure", reason };
  }
  return { kind: "success", stdout: result.output.stdout?.trim() ?? "" };
}

function makeContextPack(input: PlanningInput): ContextPack {
  const now = new Date().toISOString();
  const task: Task = {
    id: "PLANNING", projectId: "proj-local", title: "Generate a bounded plan", milestone: "planning",
    status: "READY", type: "spike", priority: "P0", risk: "low",
    definition: {
      objective: input.goal, acceptanceCriteria: ["Return a valid PlanningResult JSON object."],
      scope: { allowedPaths: [], forbiddenPaths: [] }, resources: [], verification: { required: [] },
      limits: { maxAttempts: 1, maxReviewCycles: 0 }, approval: { required: false },
    },
    routing: { complexity: "small", capabilities: [] }, provenance: { kind: "user_request", source: "planning input" },
    dependsOn: [], workflow: "simple", createdAt: now, updatedAt: now,
  };
  const evidence = input.repositoryEvidence.flatMap((entry) => entry.status === "present" ? [{ path: entry.path, content: entry.content }] : []);
  return {
    task,
    agentsMarkdownPath: "AGENTS.md",
    agentsMarkdown: evidence.find((entry) => entry.path === "AGENTS.md")?.content ?? "No AGENTS.md was present during repository analysis.",
    documents: [{ path: "PLANNING_INPUT.json", content: JSON.stringify(input) }],
    scope: task.definition.scope,
    baseRevision: input.baseRevision,
    manifest: { entries: [], createdAt: now },
  };
}

function parseJson(stdout: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly issue: string } {
  try { return { ok: true, value: JSON.parse(stdout) as unknown }; }
  catch { return { ok: false, issue: stdout.length ? "could not parse response" : "response was empty" }; }
}
