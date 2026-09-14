import { createHash } from "node:crypto";
import type {
  ContextDocument,
  ContextPack,
  BuildContextPackInput,
} from "@agentic-dev-runner/core";
import type {
  ContextManifest,
  ContextManifestEntry,
} from "@agentic-dev-runner/core";
import { stableStringify } from "./stable-serialize.js";
import { ContextPackError } from "./context-pack-error.js";

function digest(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function sortDocuments(documents: readonly ContextDocument[]): ContextDocument[] {
  const unique = new Map<string, ContextDocument>();
  for (const document of documents) {
    const existing = unique.get(document.path);
    if (existing === undefined) {
      unique.set(document.path, document);
      continue;
    }
    if (existing.content !== document.content) {
      throw new ContextPackError(
        `conflicting context documents supplied for path '${document.path}'`,
      );
    }
  }
  return [...unique.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}

function sortPaths(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
}

export function buildContextPack(input: BuildContextPackInput): ContextPack {
  const agentsMarkdown = input.agentsMarkdown;
  if (agentsMarkdown.length === 0) {
    throw new ContextPackError(
      `mandatory project rules document '${input.agentsMarkdownPath ?? "AGENTS.md"}' is missing or empty`,
    );
  }

  const agentsMarkdownPath = input.agentsMarkdownPath ?? "AGENTS.md";
  const documents = sortDocuments(input.documents ?? []);
  const scope = {
    allowedPaths: sortPaths(input.task.definition.scope.allowedPaths),
    forbiddenPaths: sortPaths(input.task.definition.scope.forbiddenPaths),
  };

  const entries: ContextManifestEntry[] = [
    {
      kind: "task",
      source: input.task.id,
      digest: digest(stableStringify(input.task)),
    },
    {
      kind: "agents_md",
      source: agentsMarkdownPath,
      digest: digest(agentsMarkdown),
    },
    ...documents.map(
      (document): ContextManifestEntry => ({
        kind: "doc",
        source: document.path,
        digest: digest(document.content),
      }),
    ),
    {
      kind: "allowed_paths",
      source: "task.definition.scope.allowedPaths",
      digest: digest(JSON.stringify(scope.allowedPaths)),
    },
    {
      kind: "forbidden_paths",
      source: "task.definition.scope.forbiddenPaths",
      digest: digest(JSON.stringify(scope.forbiddenPaths)),
    },
    {
      kind: "base_revision",
      source: "git",
      digest: digest(input.baseRevision),
    },
  ];

  const manifest: ContextManifest = {
    entries,
    createdAt: input.createdAt,
  };

  return {
    task: input.task,
    agentsMarkdownPath,
    agentsMarkdown,
    documents,
    scope,
    baseRevision: input.baseRevision,
    manifest,
  };
}
