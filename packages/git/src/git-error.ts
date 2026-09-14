export type GitFailure = {
  readonly operation: string;
  readonly command: readonly string[];
  readonly exitCode: number | null;
  readonly reason: string;
  readonly stdout: string;
  readonly stderr: string;
};

export class GitError extends Error {
  readonly failure: GitFailure;

  constructor(message: string, failure: GitFailure) {
    super(message);
    this.name = "GitError";
    this.failure = failure;
  }
}
