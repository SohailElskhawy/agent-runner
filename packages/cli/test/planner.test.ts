import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentDescriptor, AgentExecutionResult, AgentInvocation, AgentRuntime } from "@agentic-dev-runner/agents";
import type { AgentProfile, PlanningInput } from "@agentic-dev-runner/core";
import { createGitManager } from "@agentic-dev-runner/git";
import { createNodeProcessRunner } from "@agentic-dev-runner/platform";
import type { ProcessRunner } from "@agentic-dev-runner/platform";
import { createRepositoryPlanner } from "../src/application/planning/planner.js";

const roots: string[] = [];
const runtime = createNodeProcessRunner();
function repo(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), "agentic-planner-"));
  roots.push(projectRoot);
  execFileSync("git", ["init", "-q", projectRoot]);
  writeFileSync(join(projectRoot, "AGENTS.md"), "Rules");
  execFileSync("git", ["-C", projectRoot, "add", "AGENTS.md"]);
  execFileSync("git", ["-C", projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "seed"]);
  return projectRoot;
}
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

const profile: AgentProfile = { id: "planner", adapterId: "fake", capabilities: [] };
const valid = JSON.stringify({ version: 1, kind: "NEEDS_DISCOVERY", questions: [{ id: "AUTH", prompt: "Choose auth", reason: "Changes access", importance: "important", choices: ["none", "email"] }] });
const ready = JSON.stringify({ version: 1, kind: "READY_FOR_PLANNING", milestones: [{ id: "M1", title: "App", completionCriteria: ["Works"] }], tasks: [{ id: "T1", milestone: "M1", title: "Build", objective: "Build todo", acceptanceCriteria: ["Works"], provenanceSource: "goal", allowedPaths: ["src/**"], risk: "low", type: "implementation", verification: [], resources: [], dependsOn: [], routing: { complexity: "small", capabilities: [] } }] });
const input = (repositoryRoot: string, answeredQuestionIds: string[] = []): PlanningInput => ({
  repositoryRoot, goal: "build todo", baseRevision: execFileSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  repositoryEvidence: [{ path: "AGENTS.md", status: "present", content: "Rules" }], knownDecisions: answeredQuestionIds.map(() => "Email"), answeredQuestionIds, existingTaskIds: [],
});

class FakeRuntime implements AgentRuntime {
  readonly invocations: AgentInvocation[] = [];
  readonly outputs: string[];
  constructor(outputs: string[], readonly onInvoke?: (invocation: AgentInvocation) => void) { this.outputs = outputs; }
  readonly descriptor: AgentDescriptor = { id: "fake" };
  async invoke(invocation: AgentInvocation): Promise<AgentExecutionResult> {
    this.invocations.push(invocation);
    this.onInvoke?.(invocation);
    const stdout = this.outputs.shift() ?? "";
    return { kind: "success", output: { stdout }, exitCode: 0, durationMs: 1 };
  }
}

describe("repository planner", () => {
  it("allows read-only context access while prohibiting planner edits and Git", async () => {
    const projectRoot = repo();
    const agent = new FakeRuntime([valid]);
    const planner = createRepositoryPlanner({ git: createGitManager({ runner: runtime }), runner: runtime, agent, profile, worktreesDir: join(tmpdir(), "agentic-planner-worktrees"), timeoutMs: 5000, configuredVerificationChecks: [] });
    await planner(input(projectRoot));
    expect(agent.invocations[0]?.instruction).toContain("Use read-only file access to read the supplied context pack, including cat if needed.");
    expect(agent.invocations[0]?.instruction).toContain("Do not run Git or commands that modify files.");
    expect(agent.invocations[0]?.instruction).toContain('"completionCriteria"');
    expect(agent.invocations[0]?.instruction).toContain('"provenanceSource"');
    expect(agent.invocations[0]?.instruction).toContain("do not wrap milestones or tasks in another object");
    expect(agent.invocations[0]?.readOnly).toBe(true);
  });

  it("writes questions, suppresses answered IDs, then invokes again for a ready plan", async () => {
    const projectRoot = repo();
    const agent = new FakeRuntime([valid, valid, ready]);
    const planner = createRepositoryPlanner({ git: createGitManager({ runner: runtime }), runner: runtime, agent, profile, worktreesDir: join(tmpdir(), "agentic-planner-worktrees"), timeoutMs: 5000, configuredVerificationChecks: [] });
    const questions = await planner(input(projectRoot));
    expect(questions.kind).toBe("NEEDS_DISCOVERY");
    expect(readFileSync(join(projectRoot, ".agentic", "decisions.md"), "utf8")).toContain("### AUTH:");
    const result = await planner(input(projectRoot, ["AUTH"]));
    expect(result.kind).toBe("READY_FOR_PLANNING");
    expect(agent.invocations).toHaveLength(3);
    expect(agent.invocations[0]?.worktreePath).not.toBe(projectRoot);
    expect(agent.invocations.every((invocation) => invocation.readOnly)).toBe(true);
    expect(readFileSync(join(projectRoot, "AGENTS.md"), "utf8")).toBe("Rules");
    expect(result.kind === "READY_FOR_PLANNING" && result.draft).toBeTruthy();
  });

  it("repairs malformed JSON within a bounded budget and removes worktree after exhaustion", async () => {
    const projectRoot = repo();
    const agent = new FakeRuntime(["not JSON", "still not JSON"]);
    const planner = createRepositoryPlanner({ git: createGitManager({ runner: runtime }), runner: runtime, agent, profile, worktreesDir: join(tmpdir(), "agentic-planner-worktrees"), timeoutMs: 5000, configuredVerificationChecks: [] });
    await expect(planner(input(projectRoot))).rejects.toThrow(/invalid planner response/);
    expect(agent.invocations).toHaveLength(3);
    expect(await createGitManager({ runner: runtime }).worktreeExists(projectRoot, agent.invocations[0]?.worktreePath ?? "")).toBe(false);
    expect(existsSync(join(projectRoot, ".agentic", "plans"))).toBe(false);
  });

  it("repairs one malformed response and accepts a valid question result", async () => {
    const projectRoot = repo();
    const agent = new FakeRuntime(["not JSON", valid]);
    const planner = createRepositoryPlanner({ git: createGitManager({ runner: runtime }), runner: runtime, agent, profile, worktreesDir: join(tmpdir(), "agentic-planner-worktrees"), timeoutMs: 5000, configuredVerificationChecks: [] });
    expect(await planner(input(projectRoot))).toMatchObject({ kind: "NEEDS_DISCOVERY" });
    expect(agent.invocations).toHaveLength(2);
    expect(agent.invocations[1]?.instruction).toContain("invalid JSON");
  });

  it("rejects planner source edits and leaves the project checkout untouched", async () => {
    const projectRoot = repo();
    const agent = new FakeRuntime([valid], (invocation) => writeFileSync(join(invocation.worktreePath, "source.ts"), "must not escape"));
    const planner = createRepositoryPlanner({ git: createGitManager({ runner: runtime }), runner: runtime, agent, profile, worktreesDir: join(tmpdir(), "agentic-planner-worktrees"), timeoutMs: 5000, configuredVerificationChecks: [] });
    await expect(planner(input(projectRoot))).rejects.toThrow(/modified its isolated worktree/);
    expect(readFileSync(join(projectRoot, "AGENTS.md"), "utf8")).toBe("Rules");
    expect(agent.invocations).toHaveLength(1);
    expect(await createGitManager({ runner: runtime }).worktreeExists(projectRoot, agent.invocations[0]?.worktreePath ?? "")).toBe(false);
  });

  it("marks planner calls read-only so an attempted original-checkout write is refused", async () => {
    const projectRoot = repo();
    const escapedPath = join(projectRoot, "escaped.ts");
    const agent = new FakeRuntime([valid], (invocation) => {
      if (invocation.readOnly) throw new Error("read-only sandbox refused the original-checkout write");
      writeFileSync(escapedPath, "outside worktree");
    });
    const planner = createRepositoryPlanner({ git: createGitManager({ runner: runtime }), runner: runtime, agent, profile, worktreesDir: join(tmpdir(), "agentic-planner-worktrees"), timeoutMs: 5000, configuredVerificationChecks: [] });
    await expect(planner(input(projectRoot))).rejects.toThrow(/read-only sandbox refused/);
    expect(agent.invocations[0]?.readOnly).toBe(true);
    expect(existsSync(escapedPath)).toBe(false);
  });

  it("removes a partially created worktree when the add command reports failure", async () => {
    const projectRoot = repo();
    let worktreePath = "";
    const failingCreateRunner: ProcessRunner = {
      run: async (spec) => {
        const created = await runtime.run(spec);
        if (spec.executable === "git" && spec.args?.[0] === "worktree" && spec.args[1] === "add") {
          worktreePath = spec.args[3] ?? "";
          return { ...created, outcome: { kind: "completed", code: 1 }, stderr: "simulated failure" };
        }
        return created;
      },
    };
    const agent = new FakeRuntime([valid]);
    const planner = createRepositoryPlanner({ git: createGitManager({ runner: runtime }), runner: failingCreateRunner, agent, profile, worktreesDir: join(tmpdir(), "agentic-planner-worktrees"), timeoutMs: 5000, configuredVerificationChecks: [] });
    await expect(planner(input(projectRoot))).rejects.toThrow(/simulated failure/);
    expect(agent.invocations).toHaveLength(0);
    expect(existsSync(worktreePath)).toBe(false);
    expect(await createGitManager({ runner: runtime }).worktreeExists(projectRoot, worktreePath)).toBe(false);
  });
});
