export type GitStatusEntry = {
  readonly indexStatus: string;
  readonly worktreeStatus: string;
  readonly path: string;
  readonly previousPath?: string | undefined;
};

export type GitStatus = {
  readonly clean: boolean;
  readonly entries: readonly GitStatusEntry[];
};

export type RemoveWorktreeOptions = {
  readonly force?: boolean | undefined;
};

export type GitIntegrationKind = "fast-forward" | "already-integrated";

export type GitIntegrationResult = {
  readonly kind: GitIntegrationKind;
  readonly revision: string;
};

export interface GitManager {
  isRepository(cwd: string): Promise<boolean>;
  resolveHeadRevision(cwd: string): Promise<string>;
  branchExists(cwd: string, branchName: string): Promise<boolean>;
  resolveBranchRevision(cwd: string, branchName: string): Promise<string>;
  isAncestor(
    cwd: string,
    ancestorRevision: string,
    descendantRevision: string,
  ): Promise<boolean>;
  worktreeExists(cwd: string, worktreePath: string): Promise<boolean>;
  createBranch(cwd: string, branchName: string): Promise<void>;
  createWorktree(
    cwd: string,
    worktreePath: string,
    branchName: string,
  ): Promise<void>;
  status(cwd: string): Promise<GitStatus>;
  stageAll(cwd: string): Promise<void>;
  getStagedDiff(cwd: string): Promise<string>;
  getDiffAgainstRevision(cwd: string, revision: string): Promise<string>;
  commitStaged(cwd: string, message: string): Promise<string>;
  integrateBranch(cwd: string, branchName: string): Promise<GitIntegrationResult>;
  /**
   * Rebases the branch checked out in the given working tree onto the given
   * revision. The rebase may stop on conflicts; the caller detects that by
   * listing unmerged paths and must abort or resolve the rebase itself.
   */
  rebaseBranch(cwd: string, ontoRevision: string): Promise<void>;
  /**
   * Aborts an in-progress rebase in the given working tree, restoring the
   * branch to its pre-rebase state.
   */
  abortRebase(cwd: string): Promise<void>;
  /**
   * The repository-relative paths with unmerged (conflicted) index entries
   * in the given working tree.
   */
  listUnmergedPaths(cwd: string): Promise<string[]>;
  removeWorktree(
    cwd: string,
    worktreePath: string,
    options?: RemoveWorktreeOptions,
  ): Promise<void>;
}
