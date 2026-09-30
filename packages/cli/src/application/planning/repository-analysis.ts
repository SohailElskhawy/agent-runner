import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { GitManager } from "@agentic-dev-runner/git";
import type { ProcessRunner } from "@agentic-dev-runner/platform";
import type { PlanningInput, RepositoryEvidence } from "@agentic-dev-runner/core";

const MAX_EVIDENCE_BYTES = 65_536;
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
    for (const path of [...candidates].sort(comparePaths)) {
      try {
        const data = await readFile(join(projectRoot, path));
        evidence.set(path, data.toString("utf8"));
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

    let remaining = MAX_EVIDENCE_BYTES;
    const repositoryEvidence: RepositoryEvidence[] = [];
    for (const [path, content] of [...evidence].sort(([a], [b]) => comparePaths(a, b))) {
      if (content === null) {
        repositoryEvidence.push({ path, status: "absent" });
        continue;
      }
      const bytes = Buffer.from(content);
      if (bytes.byteLength <= remaining) {
        repositoryEvidence.push({ path, status: "present", content });
        remaining -= bytes.byteLength;
      } else {
        const truncated = truncateUtf8(bytes, remaining);
        repositoryEvidence.push({ path, status: "present", content: truncated });
        remaining = 0;
      }
    }
    const decisionText = repositoryEvidence.find((entry) => entry.path === ".agentic/decisions.md");
    let decisionBudget = Math.max(0, MAX_EVIDENCE_BYTES - repositoryEvidence.reduce(
      (total, entry) => total + (entry.status === "present" ? Buffer.byteLength(entry.content) : 0), 0,
    ));
    const knownDecisions = (decisionText?.status === "present" ? decisionText.content : "")
      .split(/\r?\n/)
      .map((line) => /^\s*Answer:\s*(\S.*)$/.exec(line)?.[1]?.trim())
      .filter((answer): answer is string => answer !== undefined)
      .filter((answer) => {
        const bytes = Buffer.byteLength(answer);
        if (bytes > decisionBudget) return false;
        decisionBudget -= bytes;
        return true;
      });
    return {
      repositoryRoot: projectRoot,
      goal,
      baseRevision,
      repositoryEvidence,
      knownDecisions,
      existingTaskIds: [...existingTaskIds],
    };
  };
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
  let prefix = bytes.subarray(0, prefixBytes).toString("utf8");
  while (Buffer.byteLength(prefix) > prefixBytes) prefix = Array.from(prefix).slice(0, -1).join("");
  return prefix + OMITTED;
}

function isTestPath(path: string): boolean {
  return !isExcluded(path) && /(^|[\\/])(test|tests|__tests__)([\\/]|$)|\.(test|spec)\.[^\\/]+$/i.test(path);
}
