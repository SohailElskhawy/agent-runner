import { describe, expect, it } from "vitest";
import {
  ContextPackError,
  buildContextPack,
  type BuildContextPackInput,
  type Task,
} from "@agentic-dev-runner/core";

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: "VS007",
    projectId: "proj-1",
    title: "Build context pack",
    milestone: "vertical-slice",
    status: "READY",
    type: "implementation",
    priority: "P0",
    risk: "low",
    definition: {
      objective: "Build a deterministic context pack.",
      acceptanceCriteria: ["Manifest records everything included."],
      scope: {
        allowedPaths: ["src/features/**", "src/hooks/**"],
        forbiddenPaths: ["backend/**", "database/**"],
      },
      resources: [],
      verification: { required: ["typecheck", "unit"] },
      limits: { maxAttempts: 3, maxReviewCycles: 2 },
      approval: { required: false },
    },
    routing: { complexity: "small", capabilities: ["typescript"] },
    provenance: { kind: "user_request", source: "manual" },
    dependsOn: [],
    workflow: "default",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeInput(overrides?: Partial<BuildContextPackInput>): BuildContextPackInput {
  return {
    task: makeTask(),
    agentsMarkdown: "# Agent Rules\n\nFollow the rules.",
    documents: [
      { path: "docs/ARCHITECTURE.md", content: "# Architecture" },
      { path: "docs/PROJECT_SPEC.md", content: "# Spec" },
    ],
    baseRevision: "abc1234",
    createdAt: "2026-01-01T00:00:05.000Z",
    ...overrides,
  };
}

describe("buildContextPack", () => {
  it("includes all mandatory context", () => {
    const pack = buildContextPack(makeInput());

    expect(pack.task.id).toBe("VS007");
    expect(pack.agentsMarkdownPath).toBe("AGENTS.md");
    expect(pack.agentsMarkdown).toContain("Agent Rules");
    expect(pack.baseRevision).toBe("abc1234");
    expect(pack.scope.allowedPaths).toEqual(["src/features/**", "src/hooks/**"]);
    expect(pack.scope.forbiddenPaths).toEqual(["backend/**", "database/**"]);
    expect(pack.manifest.entries.map((entry) => entry.kind)).toEqual([
      "task",
      "agents_md",
      "doc",
      "doc",
      "allowed_paths",
      "forbidden_paths",
      "base_revision",
    ]);
  });

  it("includes multiple relevant documents", () => {
    const pack = buildContextPack(makeInput());

    expect(pack.documents.map((document) => document.path)).toEqual([
      "docs/ARCHITECTURE.md",
      "docs/PROJECT_SPEC.md",
    ]);
    expect(pack.manifest.entries.filter((e) => e.kind === "doc")).toHaveLength(2);
  });

  it("produces identical manifests for identical inputs", () => {
    const first = buildContextPack(makeInput());
    const second = buildContextPack(makeInput());

    expect(second.manifest).toEqual(first.manifest);
    expect(second.manifest.entries).toEqual(first.manifest.entries);
  });

  it("sorts manifest entries deterministically for documents", () => {
    const pack = buildContextPack(
      makeInput({
        documents: [
          { path: "docs/ZED.md", content: "z" },
          { path: "docs/ARCHITECTURE.md", content: "a" },
          { path: "docs/MIDDLE.md", content: "m" },
        ],
      }),
    );

    expect(pack.documents.map((document) => document.path)).toEqual([
      "docs/ARCHITECTURE.md",
      "docs/MIDDLE.md",
      "docs/ZED.md",
    ]);
    expect(
      pack.manifest.entries
        .filter((entry) => entry.kind === "doc")
        .map((entry) => entry.source),
    ).toEqual(["docs/ARCHITECTURE.md", "docs/MIDDLE.md", "docs/ZED.md"]);
  });

  it("sorts scope paths deterministically", () => {
    const task = makeTask();
    task.definition = {
      ...task.definition,
      scope: {
        allowedPaths: ["src/z/**", "src/a/**"],
        forbiddenPaths: ["vendor/**", "docs/**"],
      },
    };
    const pack = buildContextPack(makeInput({ task }));

    expect(pack.scope.allowedPaths).toEqual(["src/a/**", "src/z/**"]);
    expect(pack.scope.forbiddenPaths).toEqual(["docs/**", "vendor/**"]);
    expect(
      pack.manifest.entries.filter((e) => e.kind === "allowed_paths")[0]?.digest,
    ).toBe(
      pack.manifest.entries.filter((e) => e.kind === "allowed_paths")[0]?.digest,
    );
  });

  it("includes the base revision in the manifest", () => {
    const pack = buildContextPack(makeInput({ baseRevision: "deadbeef" }));

    const entry = pack.manifest.entries.find(
      (candidate) => candidate.kind === "base_revision",
    );
    expect(entry).toBeDefined();
    expect(entry?.source).toBe("git");
    expect(entry?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("includes allowed and forbidden paths in the manifest", () => {
    const pack = buildContextPack(makeInput());

    const allowed = pack.manifest.entries.find(
      (entry) => entry.kind === "allowed_paths",
    );
    const forbidden = pack.manifest.entries.find(
      (entry) => entry.kind === "forbidden_paths",
    );
    expect(allowed?.source).toBe("task.definition.scope.allowedPaths");
    expect(forbidden?.source).toBe("task.definition.scope.forbiddenPaths");
    expect(allowed?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(forbidden?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("fails explicitly when mandatory AGENTS.md content is missing", () => {
    expect(() => buildContextPack(makeInput({ agentsMarkdown: "" }))).toThrow(
      ContextPackError,
    );
    try {
      buildContextPack(makeInput({ agentsMarkdown: "" }));
    } catch (error) {
      expect(error).toBeInstanceOf(ContextPackError);
      expect((error as ContextPackError).message).toContain("AGENTS.md");
    }
  });

  it("supports paths containing spaces", () => {
    const pack = buildContextPack(
      makeInput({
        documents: [
          { path: "docs/my notes/project spec.md", content: "notes" },
        ],
        task: makeTask({
          definition: {
            ...makeTask().definition,
            scope: {
              allowedPaths: ["my folder/src/**"],
              forbiddenPaths: ["other folder/docs/**"],
            },
          },
        }),
      }),
    );

    expect(pack.documents[0]?.path).toBe("docs/my notes/project spec.md");
    expect(pack.scope.allowedPaths).toEqual(["my folder/src/**"]);
    expect(pack.scope.forbiddenPaths).toEqual(["other folder/docs/**"]);
    const docEntry = pack.manifest.entries.find(
      (entry) => entry.kind === "doc",
    );
    expect(docEntry?.source).toBe("docs/my notes/project spec.md");
  });

  it("does not include unrelated repository files automatically", () => {
    const pack = buildContextPack(makeInput());

    const sources = pack.manifest.entries.map((entry) => entry.source);
    expect(sources).not.toContain("package.json");
    expect(sources).not.toContain("pnpm-lock.yaml");
    expect(pack.manifest.entries).toHaveLength(7);
  });
});
