import type { IsoTimestamp } from "./timestamp.js";
import type { Task } from "./task.js";
import type { TaskScope } from "./task-contract.js";
import type { ContextManifest } from "./context-manifest.js";

export type ContextDocument = {
  path: string;
  content: string;
};

export type ContextPack = {
  task: Task;
  agentsMarkdownPath: string;
  agentsMarkdown: string;
  documents: readonly ContextDocument[];
  scope: TaskScope;
  baseRevision: string;
  manifest: ContextManifest;
};

export type BuildContextPackInput = {
  task: Task;
  agentsMarkdown: string;
  agentsMarkdownPath?: string;
  documents?: readonly ContextDocument[];
  baseRevision: string;
  createdAt: IsoTimestamp;
};
