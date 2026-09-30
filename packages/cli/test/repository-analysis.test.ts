import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitManager } from "@agentic-dev-runner/git";
import { createNodeProcessRunner } from "@agentic-dev-runner/platform";
import { afterEach, describe, expect, it } from "vitest";
import { createRepositoryAnalyzer } from "../src/application/planning/repository-analysis.js";

const roots: string[] = [];
const analyzer = createRepositoryAnalyzer({ git: createGitManager({ runner: createNodeProcessRunner() }), runner: createNodeProcessRunner() });
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "agentic-planning-analysis-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "initial"]);
  return root;
}
function unbornRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "agentic-planning-unborn-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", root]);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("repository analysis", () => {
  it("collects project docs, manifests, and test inventory for an established repository", async () => {
    const root = repo();
    mkdirSync(join(root, "docs"));
    mkdirSync(join(root, "packages", "app", "test"), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "local rules");
    writeFileSync(join(root, "docs", "PROJECT_SPEC.md"), "spec");
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, "packages", "app", "package.json"), "{}");
    writeFileSync(join(root, "packages", "app", "test", "app.test.ts"), "test");
    execFileSync("git", ["-C", root, "add", "."]);
    execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "files"]);
    const input = await analyzer(root, "build app", ["T-1"]);
    expect(input.goal).toBe("build app");
    expect(input.existingTaskIds).toEqual(["T-1"]);
    expect(input.repositoryEvidence).toContainEqual({ path: "AGENTS.md", status: "present", content: "local rules" });
    const packageManifest = input.repositoryEvidence.find((entry) => entry.path === "packages/app/package.json");
    expect(packageManifest?.status).toBe("present");
    const tests = input.repositoryEvidence.find((entry) => entry.path === ".agentic/test-files.txt");
    expect(tests?.status === "present" && tests.content).toContain("packages/app/test/app.test.ts");
  });

  it("works in a nearly empty repository and reports optional files as absent", async () => {
    const input = await analyzer(repo(), undefined, []);
    expect(input.goal).toBe("");
    expect(input.repositoryEvidence.find((entry) => entry.path === "AGENTS.md")).toEqual({ path: "AGENTS.md", status: "absent" });
    expect(input.repositoryEvidence.find((entry) => entry.path === ".agentic/decisions.md")).toEqual({ path: ".agentic/decisions.md", status: "absent" });
  });

  it("analyzes a Git repository before its first commit", async () => {
    const input = await analyzer(unbornRepo(), "goal", []);
    expect(input.baseRevision).toBe("unborn");
  });

  it("records base revision and dirty state", async () => {
    const root = repo();
    writeFileSync(join(root, "local.txt"), "dirty");
    const input = await analyzer(root, "goal", []);
    const status = input.repositoryEvidence.find((entry) => entry.path === ".agentic/analysis-status.txt");
    expect(status?.status).toBe("present");
    expect(status?.status === "present" && status.content).toContain("dirty");
    expect(input.baseRevision).toMatch(/^[0-9a-f]{40,}$/);
  });

  it("limits collected file contents", async () => {
    const root = repo();
    writeFileSync(join(root, "AGENTS.md"), "é".repeat(100_000));
    const input = await analyzer(root, "goal", []);
    const content = input.repositoryEvidence.flatMap((entry) => entry.status === "present" ? [entry.content] : []).join("");
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(65_536);
    expect(content).toContain("omitted");
  });

  it("caps the tracked path inventory", async () => {
    const root = repo();
    mkdirSync(join(root, "files"));
    for (let index = 0; index < 505; index += 1) writeFileSync(join(root, "files", `item-${index}.txt`), "");
    execFileSync("git", ["-C", root, "add", "."]);
    execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "files"]);
    const inventory = (await analyzer(root, "goal", [])).repositoryEvidence.find((entry) => entry.path === ".agentic/tracked-files.txt");
    expect(inventory?.status === "present" && inventory.content.split("\n")).toHaveLength(501);
    expect(inventory?.status === "present" && inventory.content).toContain("omitted: tracked path limit");
  });

  it("includes late test paths beyond the general inventory cap", async () => {
    const root = repo();
    mkdirSync(join(root, "files"));
    for (let index = 0; index < 505; index += 1) writeFileSync(join(root, "files", `item-${index}.txt`), "");
    mkdirSync(join(root, "zz-tests"));
    writeFileSync(join(root, "zz-tests", "late.test.ts"), "");
    execFileSync("git", ["-C", root, "add", "."]);
    execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "files"]);
    const evidence = await analyzer(root, "goal", []);
    const tests = evidence.repositoryEvidence.find((entry) => entry.path === ".agentic/test-files.txt");
    expect(tests?.status === "present" && tests.content).toContain("zz-tests/late.test.ts");
  });

  it("includes later test paths and marks a truncated test inventory", async () => {
    const root = repo();
    mkdirSync(join(root, "zz-tests"));
    for (let index = 0; index < 505; index += 1) writeFileSync(join(root, "zz-tests", `test-${index}.test.ts`), "");
    execFileSync("git", ["-C", root, "add", "."]);
    execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "tests"]);
    const tests = (await analyzer(root, "goal", [])).repositoryEvidence.find((entry) => entry.path === ".agentic/test-files.txt");
    expect(tests?.status === "present" && tests.content).toContain("omitted: test path limit");
  });

  it("extracts only answered decision lines", async () => {
    const root = repo();
    mkdirSync(join(root, ".agentic"));
    writeFileSync(join(root, ".agentic", "decisions.md"), "### AUTH: use auth?\nAnswer: use OAuth\n\n### THEME: theme?\nAnswer:   \n");
    const input = await analyzer(root, "goal", []);
    expect(input.knownDecisions).toEqual(["use OAuth"]);
    expect(input.answeredQuestionIds).toEqual(["AUTH"]);
  });

  it("counts known decisions against the aggregate evidence byte cap", async () => {
    const root = repo();
    mkdirSync(join(root, ".agentic"));
    writeFileSync(join(root, ".agentic", "decisions.md"), `### Q-LONG: large answer\nAnswer: ${"x".repeat(100_000)}\n`);
    const input = await analyzer(root, "goal", []);
    const evidenceBytes = Buffer.byteLength(input.repositoryEvidence.flatMap((entry) => entry.status === "present" ? [entry.content] : []).join(""));
    const decisionBytes = Buffer.byteLength(input.knownDecisions.join(""));
    expect(evidenceBytes + decisionBytes).toBeLessThanOrEqual(65_536);
    expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThanOrEqual(65_536);
  });

  it("reserves bytes for known answers after later evidence consumes the content budget", async () => {
    const root = repo();
    mkdirSync(join(root, ".agentic"));
    writeFileSync(join(root, ".agentic", "decisions.md"), "### Q-AUTH: choose auth\nAnswer: Use OAuth\n");
    writeFileSync(join(root, "AGENTS.md"), "x".repeat(65_000));
    const input = await analyzer(root, "goal", []);
    expect(input.knownDecisions).toContain("Use OAuth");
    expect(input.answeredQuestionIds).toContain("Q-AUTH");
    const evidenceBytes = Buffer.byteLength(input.repositoryEvidence.flatMap((entry) => entry.status === "present" ? [entry.content] : []).join(""));
    expect(evidenceBytes + Buffer.byteLength(input.knownDecisions.join(""))).toBeLessThanOrEqual(65_536);
    expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThanOrEqual(65_536);
  });

  it("includes untracked root manifests", async () => {
    const root = repo();
    for (const name of ["pyproject.toml", "Cargo.toml", "go.mod"]) writeFileSync(join(root, name), name);
    const input = await analyzer(root, "goal", []);
    for (const name of ["pyproject.toml", "Cargo.toml", "go.mod"]) {
      expect(input.repositoryEvidence.find((entry) => entry.path === name)).toEqual({ path: name, status: "present", content: name });
    }
  });

  it("keeps evidence ordering stable", async () => {
    const root = repo();
    const first = await analyzer(root, "goal", ["b", "a"]);
    const second = await analyzer(root, "goal", ["b", "a"]);
    expect(first).toEqual(second);
    expect(first.repositoryEvidence.map((entry) => entry.path)).toEqual([...first.repositoryEvidence.map((entry) => entry.path)].sort());
  });
});
