import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeProcessRunner } from "@agentic-dev-runner/platform";
import type { ProcessRunner } from "@agentic-dev-runner/platform";
import { createGitManager, GitError } from "../src/index.js";
import type { GitManager } from "../src/index.js";

let baseDir: string;
let runner: ProcessRunner;
let git: GitManager;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "agentic git vs006 spaced base "));
  runner = createNodeProcessRunner();
  git = createGitManager({ runner });
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

async function runFixtureGit(
  cwd: string,
  args: string[],
): Promise<string> {
  const result = await runner.run({ executable: "git", args, cwd });
  if (result.outcome.kind !== "completed" || result.outcome.code !== 0) {
    throw new Error(
      `fixture git command failed: git ${args.join(" ")}: ${result.stderr}`,
    );
  }
  return result.stdout;
}

async function createRepository(name: string): Promise<string> {
  const repositoryPath = join(baseDir, name);
  mkdirSync(repositoryPath);
  await runFixtureGit(repositoryPath, ["init"]);
  await runFixtureGit(repositoryPath, ["config", "user.email", "runner@example.com"]);
  await runFixtureGit(repositoryPath, ["config", "user.name", "Agentic Runner Tests"]);
  writeFileSync(join(repositoryPath, "README.md"), "fixture content\n");
  await runFixtureGit(repositoryPath, ["add", "."]);
  await runFixtureGit(repositoryPath, ["commit", "-m", "initial commit"]);
  return repositoryPath;
}

const HEAD_PATTERN = /^[0-9a-f]{40}$/;

async function gitFailureOf(operation: Promise<unknown>): Promise<GitError> {
  try {
    await operation;
    throw new Error("expected the git operation to fail");
  } catch (caught: unknown) {
    if (caught instanceof GitError) {
      return caught;
    }
    throw caught;
  }
}

describe("NodeGitManager", () => {
  it("rejects a directory that is not a Git repository", async () => {
    expect(await git.isRepository(baseDir)).toBe(false);
  });

  it("validates a real repository, including subdirectories", async () => {
    const repo = await createRepository("repo");
    const subDirectory = join(repo, "nested dir");
    mkdirSync(subDirectory);

    expect(await git.isRepository(repo)).toBe(true);
    expect(await git.isRepository(subDirectory)).toBe(true);
  });

  it("resolves the current revision deterministically", async () => {
    const repo = await createRepository("repo");
    const expected = (await runFixtureGit(repo, ["rev-parse", "HEAD"])).trim();

    const revision = await git.resolveHeadRevision(repo);
    expect(revision).toMatch(HEAD_PATTERN);
    expect(revision).toBe(expected);
  });

  it("normalizes git command failures into GitError", async () => {
    const nonRepository = join(baseDir, "plain dir");
    mkdirSync(nonRepository);

    await expect(git.resolveHeadRevision(nonRepository)).rejects.toThrow(
      GitError,
    );
    const error = await gitFailureOf(git.resolveHeadRevision(nonRepository));
    expect(error.name).toBe("GitError");
    expect(error.failure.operation).toBe("resolveHeadRevision");
    expect(error.failure.exitCode).toBe(128);
    expect(error.failure.stderr.length).toBeGreaterThan(0);
    expect(error.failure.command).toEqual(["git", "rev-parse", "HEAD"]);
  });

  it("normalizes spawn failures for a missing git executable", async () => {
    const missing = createGitManager({
      runner,
      gitExecutable: "definitely-not-git-vs006",
    });

    await expect(
      missing.resolveHeadRevision(baseDir),
    ).rejects.toThrow(GitError);
    const error = await gitFailureOf(missing.resolveHeadRevision(baseDir));
    expect(error.failure.exitCode).toBeNull();
    expect(error.failure.reason).toContain("spawn error");
  });

  it("creates a task branch at the current revision", async () => {
    const repo = await createRepository("repo");
    const head = await git.resolveHeadRevision(repo);

    await git.createBranch(repo, "task/M001");

    const branchRevision = (
      await runFixtureGit(repo, ["rev-parse", "task/M001"])
    ).trim();
    expect(branchRevision).toBe(head);

    await expect(git.createBranch(repo, "task/M001")).rejects.toThrow(GitError);
  });

  it("creates an isolated worktree for a task branch with spaces in paths", async () => {
    const repo = await createRepository("task repo");
    const baseRevision = await git.resolveHeadRevision(repo);
    await git.createBranch(repo, "task/M001");

    const worktreePath = join(baseDir, "task worktree dir");
    await git.createWorktree(repo, worktreePath, "task/M001");

    expect(await git.isRepository(worktreePath)).toBe(true);
    expect(await git.resolveHeadRevision(worktreePath)).toBe(baseRevision);
    expect(existsSync(join(worktreePath, "README.md"))).toBe(true);
    expect(worktreePath.includes(" ")).toBe(true);
  });

  it("refuses to check the same branch out in a second worktree", async () => {
    const repo = await createRepository("repo");
    await git.createBranch(repo, "task/M001");
    const firstWorktree = join(baseDir, "worktree one");
    await git.createWorktree(repo, firstWorktree, "task/M001");

    const secondWorktree = join(baseDir, "worktree two");
    await expect(
      git.createWorktree(repo, secondWorktree, "task/M001"),
    ).rejects.toThrow(GitError);
  });

  it("inspects modified and untracked changes", async () => {
    const repo = await createRepository("repo");
    await git.createBranch(repo, "task/M001");
    const worktreePath = join(baseDir, "task worktree");
    await git.createWorktree(repo, worktreePath, "task/M001");

    writeFileSync(join(worktreePath, "README.md"), "modified content\n");
    writeFileSync(
      join(worktreePath, "new file with spaces.txt"),
      "untracked\n",
    );

    const dirty = await git.status(worktreePath);
    expect(dirty.clean).toBe(false);
    expect(dirty.entries).toHaveLength(2);

    const modified = dirty.entries.find((entry) => entry.path === "README.md");
    expect(modified?.indexStatus).toBe(" ");
    expect(modified?.worktreeStatus).toBe("M");

    const untracked = dirty.entries.find(
      (entry) => entry.path === "new file with spaces.txt",
    );
    expect(untracked?.indexStatus).toBe("?");
    expect(untracked?.worktreeStatus).toBe("?");

    await git.stageAll(worktreePath);

    const staged = await git.status(worktreePath);
    expect(staged.clean).toBe(false);
    expect(staged.entries.every((entry) => entry.worktreeStatus === " ")).toBe(
      true,
    );
    expect(
      staged.entries.some(
        (entry) => entry.path === "README.md" && entry.indexStatus === "M",
      ),
    ).toBe(true);
    expect(
      staged.entries.some(
        (entry) =>
          entry.path === "new file with spaces.txt" && entry.indexStatus === "A",
      ),
    ).toBe(true);

    const diff = await git.getStagedDiff(worktreePath);
    expect(diff).toContain("README.md");
    expect(diff).toContain("new file with spaces.txt");
  });

  it("commits staged task changes and reports the new revision", async () => {
    const repo = await createRepository("repo");
    const baseRevision = await git.resolveHeadRevision(repo);
    await git.createBranch(repo, "task/M001");
    const worktreePath = join(baseDir, "task worktree");
    await git.createWorktree(repo, worktreePath, "task/M001");

    writeFileSync(join(worktreePath, "README.md"), "committed change\n");
    await git.stageAll(worktreePath);
    const commitRevision = await git.commitStaged(
      worktreePath,
      "task M001: apply change",
    );

    expect(commitRevision).toMatch(HEAD_PATTERN);
    expect(commitRevision).not.toBe(baseRevision);
    expect(await git.resolveHeadRevision(worktreePath)).toBe(commitRevision);
    expect((await git.status(worktreePath)).clean).toBe(true);

    const committedBase = await runFixtureGit(worktreePath, [
      "rev-parse",
      "HEAD~1",
    ]);
    expect(committedBase.trim()).toBe(baseRevision);
  });

  it("rejects a commit when nothing is staged", async () => {
    const repo = await createRepository("repo");

    await expect(
      git.commitStaged(repo, "empty commit"),
    ).rejects.toThrow(GitError);
    const error = await gitFailureOf(git.commitStaged(repo, "empty commit"));
    expect(error.failure.operation).toBe("commitStaged");
    expect(error.failure.exitCode).toBe(1);
  });

  it("removes a clean worktree and allows re-creation", async () => {
    const repo = await createRepository("repo");
    await git.createBranch(repo, "task/M001");
    const worktreePath = join(baseDir, "task worktree");
    await git.createWorktree(repo, worktreePath, "task/M001");

    await git.removeWorktree(repo, worktreePath);

    expect(existsSync(worktreePath)).toBe(false);

    await git.createWorktree(repo, worktreePath, "task/M001");
    expect(await git.isRepository(worktreePath)).toBe(true);
  });

  it("requires force to remove a dirty worktree", async () => {
    const repo = await createRepository("repo");
    await git.createBranch(repo, "task/M001");
    const worktreePath = join(baseDir, "task worktree");
    await git.createWorktree(repo, worktreePath, "task/M001");
    writeFileSync(join(worktreePath, "README.md"), "uncommitted\n");

    await expect(
      git.removeWorktree(repo, worktreePath),
    ).rejects.toThrow(GitError);
    expect(existsSync(worktreePath)).toBe(true);

    await git.removeWorktree(repo, worktreePath, { force: true });
    expect(existsSync(worktreePath)).toBe(false);
  });
});
