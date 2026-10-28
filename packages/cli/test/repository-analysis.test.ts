import { execFileSync } from "node:child_process";
import { closeSync, ftruncateSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitManager } from "@agentic-dev-runner/git";
import { createNodeProcessRunner } from "@agentic-dev-runner/platform";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRepositoryAnalyzer } from "../src/application/planning/repository-analysis.js";
import { writeDiscoveryQuestions } from "../src/application/planning/plan-files.js";

const fileReads = vi.hoisted(() => vi.fn());
const fileAccess = vi.hoisted(() => ({ reads: [] as { path: string; length: number }[], closed: [] as string[], fail: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: (...args: Parameters<typeof actual.readFile>) => {
    fileReads(args[0]);
    return actual.readFile(...args);
  }, open: async (...args: Parameters<typeof actual.open>) => {
    const file = await actual.open(...args);
    const path = String(args[0]);
    return new Proxy(file, { get(target, property) {
      if (property === "read") return (...readArgs: unknown[]) => {
        fileAccess.reads.push({ path, length: Number(readArgs[2]) });
        if (path === fileAccess.fail) throw new Error("simulated read failure");
        return Reflect.apply(target.read, target, readArgs);
      };
      if (property === "close") return () => {
        fileAccess.closed.push(path);
        return target.close();
      };
      return Reflect.get(target, property, target);
    } });
  } };
});

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
afterEach(() => { fileAccess.fail = ""; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

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

  it("bounds candidate reads and ignores a truncated decision line", async () => {
    const root = repo();
    mkdirSync(join(root, ".agentic"));
    const decisions = join(root, ".agentic", "decisions.md");
    const prefix = "### FIRST: question\nAnswer: keep\n### SECOND: question\nAnswer: ";
    writeFileSync(decisions, prefix + "x".repeat(65_536));
    const manifest = join(root, "package.json");
    const fd = openSync(manifest, "w");
    ftruncateSync(fd, 16 * 1024 * 1024);
    closeSync(fd);
    fileReads.mockClear();
    fileAccess.reads.length = 0;
    fileAccess.closed.length = 0;
    const input = await analyzer(root);
    expect(fileReads.mock.calls.map(([path]) => path)).not.toContain(decisions);
    expect(fileReads.mock.calls.map(([path]) => path)).not.toContain(manifest);
    for (const path of [decisions, manifest]) {
      expect(fileAccess.reads.filter((read) => read.path === path).reduce((sum, read) => sum + read.length, 0)).toBeLessThanOrEqual(65_537);
      expect(fileAccess.closed).toContain(path);
    }
    expect(input.knownDecisions).toEqual(["keep"]);
    expect(input.answeredQuestionIds).toEqual(["FIRST"]);
    expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThanOrEqual(65_536);
  });

  it("closes a candidate after a read failure and propagates the error", async () => {
    const root = repo();
    const path = join(root, "AGENTS.md");
    writeFileSync(path, "rules");
    fileAccess.closed.length = 0;
    fileAccess.fail = path;
    await expect(analyzer(root)).rejects.toThrow("simulated read failure");
    expect(fileAccess.closed).toContain(path);
  });

  it("does not split UTF-8 characters at the read or serialized boundaries", async () => {
    const root = repo();
    writeFileSync(join(root, "AGENTS.md"), "😀".repeat(20_000));
    const input = await analyzer(root);
    const content = input.repositoryEvidence.find((entry) => entry.path === "AGENTS.md");
    expect(content?.status === "present" && content.content).toContain("omitted");
    expect(content?.status === "present" && content.content).not.toContain("�");
    expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThanOrEqual(65_536);
  });

  it("keeps a complete final decision when the file is exactly at the read limit", async () => {
    const root = repo();
    mkdirSync(join(root, ".agentic"));
    const answer = "### LAST: question\nAnswer: yes";
    writeFileSync(join(root, ".agentic", "decisions.md"), " ".repeat(65_536 - Buffer.byteLength(answer) - 1) + "\n" + answer);
    const input = await analyzer(root);
    expect(input.knownDecisions).toEqual(["yes"]);
    expect(input.answeredQuestionIds).toEqual(["LAST"]);
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

  it("reads multiline values while retaining legacy eligibility, first answers, and duplicate IDs", async () => {
    const root = repo();
    mkdirSync(join(root, ".agentic"));
    writeFileSync(join(root, ".agentic", "decisions.md"), "### A: prompt\r\nAnswer: first\r\n  second\r\n\r\n  third\r\nAnswer: ignored\r\n### _hidden: prompt\r\nAnswer: hidden\r\nQuestion ID: A\r\nAnswer:\r\n  body\r\n### EMPTY: prompt\r\nAnswer:\r\nWhy: end\r\nAnswer: ignored\r\n");
    const input = await analyzer(root);
    expect(input.knownDecisions).toEqual(["first\nsecond\n\nthird", "body"]);
    expect(input.answeredQuestionIds).toEqual(["A", "A"]);
  });

  it("preserves a later nonempty answer but the analyzer still uses the empty first answer", async () => {
    const root = repo();
    mkdirSync(join(root, ".agentic"));
    const path = join(root, ".agentic", "decisions.md");
    const block = "### AUTH: old\nAnswer:\nNote: later answer follows\nAnswer: yes\n";
    writeFileSync(path, block);
    await writeDiscoveryQuestions(root, [{ id: "AUTH", prompt: "New?", reason: "Reason", choices: [], importance: "important" }]);
    const input = await analyzer(root);
    expect(input.answeredQuestionIds).not.toContain("AUTH");
    expect(input.knownDecisions).not.toContain("yes");
    expect(readFileSync(path, "utf8")).toContain(block);
  });

  it("preserves an over-budget answer when its question is asked again", async () => {
    const root = repo();
    mkdirSync(join(root, ".agentic"));
    const path = join(root, ".agentic", "decisions.md");
    const block = `### BIG: old\nAnswer:\n  ${"x".repeat(33_000)}\n`;
    writeFileSync(path, block);
    expect((await analyzer(root)).answeredQuestionIds).not.toContain("BIG");
    await writeDiscoveryQuestions(root, [{ id: "BIG", prompt: "New?", reason: "Reason", choices: [], importance: "important" }]);
    expect(readFileSync(path, "utf8")).toContain(block);
    expect((await analyzer(root)).answeredQuestionIds).not.toContain("BIG");
  });

  it("returns legacy heading IDs while retaining Question ID values", async () => {
    const root = repo();
    mkdirSync(join(root, ".agentic"));
    writeFileSync(join(root, ".agentic", "decisions.md"), "## id-é: x\nAnswer: one\n## foo—bar: x\nAnswer: two\nQuestion ID: _id\nAnswer: three\n## _hidden: x\nAnswer: hidden\n");
    const input = await analyzer(root);
    expect(input.answeredQuestionIds).toEqual(["id", "foo", "_id"]);
    expect(input.knownDecisions).toEqual(["one", "two", "three"]);
  });

  it("does not attribute an ineligible heading's answer to the preceding question", async () => {
    const root = repo();
    mkdirSync(join(root, ".agentic"));
    writeFileSync(join(root, ".agentic", "decisions.md"), "### PREVIOUS: prompt\n### _hidden: prompt\nAnswer: hidden\n### LAST:\nAnswer: no prompt\nQuestion ID: valid\nAnswer: yes\n");
    const input = await analyzer(root);
    expect(input.knownDecisions).toEqual(["yes"]);
    expect(input.answeredQuestionIds).toEqual(["valid"]);
  });

  it("rejects an open truncated answer without reading beyond the sentinel", async () => {
    const root = repo();
    mkdirSync(join(root, ".agentic"));
    const path = join(root, ".agentic", "decisions.md");
    const prefix = "### FIRST: question\nAnswer: keep\nWhy: end\n### OPEN: question\nAnswer: value\n";
    writeFileSync(path, prefix + "  ".padEnd(65_536 - Buffer.byteLength(prefix), "x") + "é");
    fileAccess.reads.length = 0;
    await expect(analyzer(root)).rejects.toThrow(/OPEN.*65536.*shorten/i);
    expect(fileAccess.reads.filter((read) => read.path === path).reduce((sum, read) => sum + read.length, 0)).toBe(65_537);
  });

  it("distinguishes true EOF from a 65537-byte truncation with a split UTF-8 character", async () => {
    const root = repo();
    mkdirSync(join(root, ".agentic"));
    const path = join(root, ".agentic", "decisions.md");
    const prefix = "### LAST: question\nAnswer: yes\n";
    const finalAnswer = "### LAST: question\nAnswer: yes";
    const exact = "x".repeat(65_536 - Buffer.byteLength(finalAnswer) - 1) + "\n" + finalAnswer;
    expect(Buffer.byteLength(exact)).toBe(65_536);
    writeFileSync(path, exact);
    const input = await analyzer(root);
    expect(input.answeredQuestionIds).toEqual(["LAST"]);
    expect(input.knownDecisions).toEqual(["yes"]);
    const sentinel = " ".repeat(65_536 - Buffer.byteLength(prefix) - 1) + "\n" + prefix + "#";
    expect(Buffer.byteLength(sentinel)).toBe(65_537);
    writeFileSync(path, sentinel);
    await expect(analyzer(root)).rejects.toThrow(/LAST.*65536.*shorten/i);
    const split = prefix + "  ".padEnd(65_535 - Buffer.byteLength(prefix), "x") + "é";
    expect(Buffer.byteLength(split)).toBe(65_537);
    writeFileSync(path, split);
    await expect(analyzer(root)).rejects.toThrow(/LAST.*65536.*shorten/i);
  });

  it("omits an over-budget multiline answer whole while retaining a later small answer", async () => {
    const root = repo();
    mkdirSync(join(root, ".agentic"));
    writeFileSync(join(root, ".agentic", "decisions.md"), `### BIG: question\nAnswer:\n  ${"x".repeat(33_000)}\n### SMALL: question\nAnswer: yes`);
    const input = await analyzer(root);
    expect(input.knownDecisions).toEqual(["yes"]);
    expect(input.answeredQuestionIds).toEqual(["SMALL"]);
    expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThanOrEqual(65_536);
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

  it("caps serialized escaped answers while retaining earlier answers and matching IDs", async () => {
    const root = repo();
    mkdirSync(join(root, ".agentic"));
    writeFileSync(join(root, ".agentic", "decisions.md"), `### Q-SMALL: first\nAnswer: keep me\n\n### Q-ESCAPED: large\nAnswer: ${"\0".repeat(12_000)}\n`);
    const input = await analyzer(root, "goal", []);
    expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThanOrEqual(65_536);
    expect(input.knownDecisions).toContain("keep me");
    expect(input.answeredQuestionIds).toEqual(["Q-SMALL"]);
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
