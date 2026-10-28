import { open, readdir } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";
import type { GitManager } from "@agentic-dev-runner/git";
import type { ProcessRunner } from "@agentic-dev-runner/platform";
import type { PlanningInput, RepositoryEvidence } from "@agentic-dev-runner/core";

const MAX_EVIDENCE_BYTES = 65_536;
const MAX_ANSWER_BYTES = MAX_EVIDENCE_BYTES / 2;
const MAX_TRACKED_PATHS = 500;
const OMITTED = "\n[omitted: evidence size limit]";
const OPTIONAL_FILES = [
  "AGENTS.md", "docs/PROJECT_SPEC.md", "docs/ARCHITECTURE.md", "docs/V0.1_SCOPE.md",
  "docs/ADRS.md", "docs/ROADMAP.md", ".agentic/decisions.md",
];
const MANIFEST_NAMES = new Set([
  "package.json", "pnpm-workspace.yaml", "pyproject.toml", "requirements.txt", "Cargo.toml",
  "go.mod", "pom.xml", "build.gradle", "build.gradle.kts", "composer.json",
]);
const EXCLUDED = new Set(["node_modules", "vendor", "dist", "build", "coverage", ".git", ".next", ".turbo"]);

export function createRepositoryAnalyzer(options: { readonly git: GitManager; readonly runner: ProcessRunner }) {
  return async function analyzeRepository(
    projectRoot: string,
    goal = "",
    existingTaskIds: readonly string[] = [],
  ): Promise<PlanningInput> {
    const [baseRevision, status] = await Promise.all([
      options.git.resolveHeadRevision(projectRoot).catch(async () => {
        if (!(await options.git.isRepository(projectRoot))) throw new Error(`not a Git repository: ${projectRoot}`);
        const head = await options.runner.run({ executable: "git", args: ["rev-parse", "--verify", "HEAD"], cwd: projectRoot });
        if (head.outcome.kind === "completed" && head.outcome.code !== 0) return "unborn";
        throw new Error(`could not resolve repository HEAD: ${head.stderr.trim() || head.outcome.kind}`);
      }),
      options.git.status(projectRoot),
    ]);
    const listed = await options.runner.run({ executable: "git", args: ["ls-files", "-z"], cwd: projectRoot });
    if (listed.outcome.kind !== "completed" || listed.outcome.code !== 0) {
      throw new Error(`could not list tracked repository paths: ${listed.stderr.trim() || listed.outcome.kind}`);
    }
    const tracked = listed.stdout.split("\0").filter((path) => path && !isExcluded(path)).sort(comparePaths);
    const paths = tracked.slice(0, MAX_TRACKED_PATHS);
    const candidates = new Set(OPTIONAL_FILES);
    for (const name of MANIFEST_NAMES) candidates.add(name);
    const rootEntries = await readdir(projectRoot, { withFileTypes: true });
    for (const directory of rootEntries.filter((entry) => entry.isDirectory() && !EXCLUDED.has(entry.name)).sort((a, b) => comparePaths(a.name, b.name))) {
      const child = join(projectRoot, directory.name);
      const childEntries = await readdir(child, { withFileTypes: true }).catch(() => []);
      for (const entry of childEntries) {
        if (entry.isFile() && MANIFEST_NAMES.has(entry.name)) candidates.add(`${directory.name}/${entry.name}`);
      }
      if (directory.name === "packages" || directory.name === "apps") {
        for (const nested of childEntries.filter((entry) => entry.isDirectory() && !EXCLUDED.has(entry.name)).sort((a, b) => comparePaths(a.name, b.name))) {
          for (const entry of await readdir(join(child, nested.name), { withFileTypes: true }).catch(() => [])) {
            if (entry.isFile() && MANIFEST_NAMES.has(entry.name)) candidates.add(`${directory.name}/${nested.name}/${entry.name}`);
          }
        }
      }
    }
    for (const path of tracked) {
      const parts = path.split("/");
      if ((parts.length <= 2 || ((parts[0] === "packages" || parts[0] === "apps") && parts.length === 3)) && MANIFEST_NAMES.has(parts.at(-1) ?? "")) candidates.add(path);
    }
    const evidence = new Map<string, string | null>();
    let decisions = "";
    for (const path of [...candidates].sort(comparePaths)) {
      try {
        const file = await open(join(projectRoot, path), "r");
        let bytesRead = 0;
        const data = Buffer.alloc(MAX_EVIDENCE_BYTES + 1);
        try {
          while (bytesRead < data.length) {
            const result = await file.read(data, bytesRead, data.length - bytesRead, null);
            if (result.bytesRead === 0) break;
            bytesRead += result.bytesRead;
          }
        } finally {
          await file.close();
        }
        const truncated = bytesRead > MAX_EVIDENCE_BYTES;
        const content = truncated
          ? new StringDecoder("utf8").write(data.subarray(0, MAX_EVIDENCE_BYTES))
          : data.subarray(0, bytesRead).toString("utf8");
        if (path === ".agentic/decisions.md") {
          decisions = truncated ? content.slice(0, content.lastIndexOf("\n") + 1) : content;
        }
        evidence.set(path, truncated ? content + OMITTED : content);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
        evidence.set(path, null);
      }
    }
    evidence.set(".agentic/analysis-status.txt", [
      `baseRevision: ${baseRevision}`, `workingTree: ${status.clean ? "clean" : "dirty"}`,
      ...status.entries.map((entry) => `${entry.indexStatus}${entry.worktreeStatus} ${entry.path}`).sort(),
    ].join("\n"));
    evidence.set(".agentic/tracked-files.txt", inventory(paths, tracked.length > paths.length));
    const testPaths = tracked.filter(isTestPath);
    evidence.set(".agentic/test-files.txt", inventory(testPaths.slice(0, MAX_TRACKED_PATHS), testPaths.length > MAX_TRACKED_PATHS, "test path"));

    const sortedEvidence = [...evidence].sort(([a], [b]) => comparePaths(a, b));
    const shellEvidence = sortedEvidence.map(([path, content]) => content === null
      ? { path, status: "absent" as const }
      : { path, status: "present" as const, content: "" });
    const metadataShell = {
      repositoryRoot: projectRoot,
      goal,
      baseRevision,
      repositoryEvidence: shellEvidence,
      knownDecisions: [],
      answeredQuestionIds: [],
      existingTaskIds: [...existingTaskIds],
    };
    const answerBudget = Math.max(0, Math.min(MAX_ANSWER_BYTES, MAX_EVIDENCE_BYTES - Buffer.byteLength(JSON.stringify(metadataShell))));
    const answers = selectAnswers(parseAnswers(decisions), answerBudget);
    const inputShell = {
      repositoryRoot: projectRoot,
      goal,
      baseRevision,
      repositoryEvidence: shellEvidence,
      knownDecisions: answers.map((answer) => answer.answer),
      answeredQuestionIds: answers.map((answer) => answer.id),
      existingTaskIds: [...existingTaskIds],
    };
    let remaining = Math.max(0, MAX_EVIDENCE_BYTES - Buffer.byteLength(JSON.stringify(inputShell)));
    const repositoryEvidence: RepositoryEvidence[] = [];
    for (const [path, content] of sortedEvidence) {
      if (content === null) {
        repositoryEvidence.push({ path, status: "absent" });
        continue;
      }
      const serializedBytes = serializedContentBytes(content);
      if (serializedBytes <= remaining) {
        repositoryEvidence.push({ path, status: "present", content });
        remaining -= serializedBytes;
      } else {
        const truncated = fitSerializedContent(content, remaining);
        repositoryEvidence.push({ path, status: "present", content: truncated });
        remaining = 0;
      }
    }
    return {
      repositoryRoot: projectRoot,
      goal,
      baseRevision,
      repositoryEvidence,
      knownDecisions: answers.map((answer) => answer.answer),
      answeredQuestionIds: answers.map((answer) => answer.id),
      existingTaskIds: [...existingTaskIds],
    };
  };
}

function parseAnswers(content: string): { id: string; answer: string }[] {
  let id: string | undefined;
  const answers: { id: string; answer: string }[] = [];
  for (const line of content.split(/\r?\n/)) {
    const question = /^\s*Question ID:\s*(\S+)\s*$/.exec(line)
      ?? /^\s*#{1,6}\s+([A-Za-z0-9][A-Za-z0-9_.-]*)\s*(?::|—|-)\s*.+$/.exec(line);
    if (question?.[1] !== undefined) {
      id = question[1];
      continue;
    }
    const answerLine = /^\s*Answer:(.*)$/.exec(line);
    if (answerLine !== null) {
      const answer = answerLine[1]?.trim() ?? "";
      if (id !== undefined && answer.length > 0) answers.push({ id, answer });
      id = undefined;
    }
  }
  return answers;
}

function selectAnswers(answers: readonly { id: string; answer: string }[], budget: number): { id: string; answer: string }[] {
  const selected: { id: string; answer: string }[] = [];
  for (const answer of answers) {
    const candidate = [...selected, answer];
    const answerBytes = Buffer.byteLength(JSON.stringify(candidate.map((entry) => entry.answer))) - 2;
    const idBytes = Buffer.byteLength(JSON.stringify(candidate.map((entry) => entry.id))) - 2;
    if (answerBytes + idBytes <= budget) selected.push(answer);
  }
  return selected;
}

function serializedContentBytes(content: string): number {
  return Buffer.byteLength(JSON.stringify(content)) - 2;
}

function fitSerializedContent(content: string, budget: number): string {
  const bytes = Buffer.from(content);
  let low = 0;
  let high = bytes.byteLength;
  let result = "";
  while (low <= high) {
    const candidateBytes = Math.floor((low + high) / 2);
    const candidate = candidateBytes >= bytes.byteLength ? content : truncateUtf8(bytes, candidateBytes);
    if (serializedContentBytes(candidate) <= budget) {
      result = candidate;
      low = candidateBytes + 1;
    } else {
      high = candidateBytes - 1;
    }
  }
  return result;
}

function inventory(paths: readonly string[], truncated: boolean, limit = "tracked path"): string {
  return [...paths, ...(truncated ? [`[omitted: ${limit} limit]`] : [])].join("\n");
}

function isExcluded(path: string): boolean {
  return path.split(/[\\/]/).some((part) => EXCLUDED.has(part));
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function truncateUtf8(bytes: Buffer, budget: number): string {
  if (budget <= 0) return "";
  if (budget <= Buffer.byteLength(OMITTED)) return OMITTED.slice(0, budget);
  const prefixBytes = budget - Buffer.byteLength(OMITTED);
  return new StringDecoder("utf8").write(bytes.subarray(0, prefixBytes)) + OMITTED;
}

function isTestPath(path: string): boolean {
  return !isExcluded(path) && /(^|[\\/])(test|tests|__tests__)([\\/]|$)|\.(test|spec)\.[^\\/]+$/i.test(path);
}
