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

export interface GitManager {
  isRepository(cwd: string): Promise<boolean>;
  resolveHeadRevision(cwd: string): Promise<string>;
  createBranch(cwd: string, branchName: string): Promise<void>;
  createWorktree(
    cwd: string,
    worktreePath: string,
    branchName: string,
  ): Promise<void>;
  status(cwd: string): Promise<GitStatus>;
  stageAll(cwd: string): Promise<void>;
  getStagedDiff(cwd: string): Promise<string>;
  commitStaged(cwd: string, message: string): Promise<string>;
  removeWorktree(
    cwd: string,
    worktreePath: string,
    options?: RemoveWorktreeOptions,
  ): Promise<void>;
}
