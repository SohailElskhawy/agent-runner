export type {
  GitManager,
  GitStatus,
  GitStatusEntry,
  RemoveWorktreeOptions,
} from "./git-manager.js";
export { GitError, type GitFailure } from "./git-error.js";
export {
  createGitManager,
  NodeGitManager,
  type GitManagerOptions,
} from "./node-git-manager.js";
