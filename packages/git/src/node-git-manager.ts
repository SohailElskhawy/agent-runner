import { isAbsolute, resolve } from "node:path";
import type {
  ProcessOutcome,
  ProcessResult,
  ProcessRunner,
} from "@agentic-dev-runner/platform";
import type {
  GitIntegrationResult,
  GitManager,
  GitStatus,
  GitStatusEntry,
  RemoveWorktreeOptions,
} from "./git-manager.js";
import { GitError, type GitFailure } from "./git-error.js";

const DEFAULT_GIT_EXECUTABLE = "git";

export type GitManagerOptions = {
  readonly runner: ProcessRunner;
  readonly gitExecutable?: string | undefined;
};

export function createGitManager(options: GitManagerOptions): GitManager {
  return new NodeGitManager(options);
}

export class NodeGitManager implements GitManager {
  private readonly runner: ProcessRunner;
  private readonly gitExecutable: string;

  constructor(options: GitManagerOptions) {
    this.runner = options.runner;
    this.gitExecutable = options.gitExecutable ?? DEFAULT_GIT_EXECUTABLE;
  }

  async isRepository(cwd: string): Promise<boolean> {
    const args = ["rev-parse", "--is-inside-work-tree"];
    const result = await this.runner.run({
      executable: this.gitExecutable,
      args,
      cwd,
    });
    if (result.outcome.kind === "completed") {
      return result.stdout.trim() === "true";
    }
    throw this.gitError("isRepository", args, result);
  }

  async resolveHeadRevision(cwd: string): Promise<string> {
    const args = ["rev-parse", "HEAD"];
    const result = await this.runGit(cwd, args, "resolveHeadRevision");
    const revision = result.stdout.trim();
    if (revision.length === 0) {
      throw this.gitError(
        "resolveHeadRevision",
        args,
        result,
        "empty revision output",
      );
    }
    return revision;
  }

  async branchExists(cwd: string, branchName: string): Promise<boolean> {
    const args = ["rev-parse", "--verify", "--quiet", branchRef(branchName)];
    this.requireNonEmpty(branchName, "branchExists", "branch name", args);
    const result = await this.runner.run({
      executable: this.gitExecutable,
      args: [...args],
      cwd,
    });
    if (result.outcome.kind === "completed") {
      if (result.outcome.code === 0) {
        return true;
      }
      if (result.outcome.code === 1) {
        return false;
      }
    }
    throw this.gitError("branchExists", args, result);
  }

  async resolveBranchRevision(
    cwd: string,
    branchName: string,
  ): Promise<string> {
    const args = ["rev-parse", "--verify", branchRef(branchName)];
    this.requireNonEmpty(branchName, "resolveBranchRevision", "branch name", args);
    const result = await this.runGit(cwd, args, "resolveBranchRevision");
    const revision = result.stdout.trim();
    if (revision.length === 0) {
      throw this.gitError(
        "resolveBranchRevision",
        args,
        result,
        "empty revision output",
      );
    }
    return revision;
  }

  async isAncestor(
    cwd: string,
    ancestorRevision: string,
    descendantRevision: string,
  ): Promise<boolean> {
    const args = [
      "merge-base",
      "--is-ancestor",
      ancestorRevision,
      descendantRevision,
    ];
    this.requireNonEmpty(
      ancestorRevision,
      "isAncestor",
      "ancestor revision",
      args,
    );
    this.requireNonEmpty(
      descendantRevision,
      "isAncestor",
      "descendant revision",
      args,
    );
    const result = await this.runner.run({
      executable: this.gitExecutable,
      args: [...args],
      cwd,
    });
    if (result.outcome.kind === "completed") {
      if (result.outcome.code === 0) {
        return true;
      }
      if (result.outcome.code === 1) {
        return false;
      }
    }
    throw this.gitError("isAncestor", args, result);
  }

  async worktreeExists(cwd: string, worktreePath: string): Promise<boolean> {
    const args = ["worktree", "list", "--porcelain"];
    this.requireNonEmpty(worktreePath, "worktreeExists", "worktree path", args);
    const result = await this.runGit(cwd, args, "worktreeExists");
    const target = normalizeWorktreePath(worktreePath);
    return parseWorktreeList(result.stdout).some(
      (entry) => normalizeWorktreePath(entry) === target,
    );
  }

  async createBranch(cwd: string, branchName: string): Promise<void> {
    const args = ["branch", branchName];
    this.requireNonEmpty(branchName, "createBranch", "branch name", args);
    await this.runGit(cwd, args, "createBranch");
  }

  async createWorktree(
    cwd: string,
    worktreePath: string,
    branchName: string,
  ): Promise<void> {
    const args = ["worktree", "add", worktreePath, branchName];
    this.requireNonEmpty(worktreePath, "createWorktree", "worktree path", args);
    this.requireNonEmpty(branchName, "createWorktree", "branch name", args);
    await this.runGit(cwd, args, "createWorktree");
  }

  async status(cwd: string): Promise<GitStatus> {
    const result = await this.runGit(
      cwd,
      ["status", "--porcelain", "-z"],
      "status",
    );
    return parsePorcelainStatus(result.stdout);
  }

  async stageAll(cwd: string): Promise<void> {
    await this.runGit(cwd, ["add", "-A"], "stageAll");
  }

  async getStagedDiff(cwd: string): Promise<string> {
    const result = await this.runGit(cwd, ["diff", "--cached"], "getStagedDiff");
    return result.stdout;
  }

  async getDiffAgainstRevision(
    cwd: string,
    revision: string,
  ): Promise<string> {
    const args = ["diff", revision];
    this.requireNonEmpty(revision, "getDiffAgainstRevision", "revision", args);
    const result = await this.runGit(cwd, args, "getDiffAgainstRevision");
    return result.stdout;
  }

  async commitStaged(cwd: string, message: string): Promise<string> {
    const args = ["commit", "-m", message];
    this.requireNonEmpty(message, "commitStaged", "commit message", args);
    await this.runGit(cwd, args, "commitStaged");
    return this.resolveHeadRevision(cwd);
  }

  async integrateBranch(
    cwd: string,
    branchName: string,
  ): Promise<GitIntegrationResult> {
    const args = ["merge", "--ff-only", branchName];
    this.requireNonEmpty(branchName, "integrateBranch", "branch name", args);
    const currentStatus = await this.status(cwd);
    if (!currentStatus.clean) {
      throw this.preconditionError(
        "integrateBranch",
        args,
        "integration worktree has uncommitted changes",
      );
    }
    const revisionBefore = await this.resolveHeadRevision(cwd);
    await this.runGit(cwd, args, "integrateBranch");
    const revisionAfter = await this.resolveHeadRevision(cwd);
    return {
      kind: revisionBefore === revisionAfter ? "already-integrated" : "fast-forward",
      revision: revisionAfter,
    };
  }

  async removeWorktree(
    cwd: string,
    worktreePath: string,
    options?: RemoveWorktreeOptions,
  ): Promise<void> {
    const args =
      options?.force === true
        ? ["worktree", "remove", "--force", worktreePath]
        : ["worktree", "remove", worktreePath];
    this.requireNonEmpty(worktreePath, "removeWorktree", "worktree path", args);
    await this.runGit(cwd, args, "removeWorktree");
  }

  private async runGit(
    cwd: string,
    args: readonly string[],
    operation: string,
  ): Promise<ProcessResult> {
    const result = await this.runner.run({
      executable: this.gitExecutable,
      args: [...args],
      cwd,
    });
    if (result.outcome.kind === "completed" && result.outcome.code === 0) {
      return result;
    }
    throw this.gitError(operation, args, result);
  }

  private gitError(
    operation: string,
    args: readonly string[],
    result: ProcessResult,
    overrideReason?: string,
  ): GitError {
    const outcome = result.outcome as ProcessOutcome;
    const exitCode = outcome.kind === "completed" ? outcome.code : null;
    const reason = overrideReason ?? describeOutcome(outcome);
    const failure: GitFailure = {
      operation,
      command: [this.gitExecutable, ...args],
      exitCode,
      reason,
      stdout: result.stdout,
      stderr: result.stderr,
    };
    return new GitError(
      `Git operation "${operation}" failed (${reason})`,
      failure,
    );
  }

  private requireNonEmpty(
    value: string,
    operation: string,
    label: string,
    command: readonly string[],
  ): void {
    if (typeof value !== "string" || value.length === 0) {
      throw new GitError(
        `Git operation "${operation}" failed (invalid ${label})`,
        {
          operation,
          command: [this.gitExecutable, ...command],
          exitCode: null,
          reason: `invalid ${label}`,
          stdout: "",
          stderr: "",
        },
      );
    }
  }

  private preconditionError(
    operation: string,
    args: readonly string[],
    reason: string,
  ): GitError {
    return new GitError(`Git operation "${operation}" failed (${reason})`, {
      operation,
      command: [this.gitExecutable, ...args],
      exitCode: null,
      reason,
      stdout: "",
      stderr: "",
    });
  }
}

function describeOutcome(outcome: ProcessOutcome): string {
  switch (outcome.kind) {
    case "completed":
      return `exit code ${String(outcome.code)}`;
    case "terminated":
      return `terminated by signal ${outcome.signal}`;
    case "timeout":
      return "timed out";
    case "cancelled":
      return "cancelled";
    case "spawn-error":
      return `spawn error ${outcome.code}: ${outcome.message}`;
  }
}

function branchRef(branchName: string): string {
  return `refs/heads/${branchName}`;
}

export function parseWorktreeList(output: string): string[] {
  const paths: string[] = [];
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      paths.push(line.slice("worktree ".length));
    }
  }
  return paths;
}

function normalizeWorktreePath(worktreePath: string): string {
  const absolute = isAbsolute(worktreePath)
    ? worktreePath
    : resolve(worktreePath);
  const normalized = resolve(absolute);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function parsePorcelainStatus(output: string): GitStatus {
  const fields = output.split("\0").filter((field) => field.length > 0);
  const entries: GitStatusEntry[] = [];
  let position = 0;
  while (position < fields.length) {
    const field = fields[position] ?? "";
    position += 1;
    const indexStatus = field.slice(0, 1);
    const worktreeStatus = field.slice(1, 2);
    const separator = field.slice(2, 3);
    const path = field.slice(3);
    if (separator !== " " || path.length === 0) {
      throw new Error(`Malformed git status output: ${JSON.stringify(field)}`);
    }
    const isMoved =
      indexStatus === "R" ||
      indexStatus === "C" ||
      worktreeStatus === "R" ||
      worktreeStatus === "C";
    let previousPath: string | undefined;
    if (isMoved) {
      previousPath = fields[position] ?? "";
      position += 1;
    }
    entries.push({
      indexStatus,
      worktreeStatus,
      path,
      ...(previousPath === undefined ? {} : { previousPath }),
    });
  }
  return { clean: entries.length === 0, entries };
}
