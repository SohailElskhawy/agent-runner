import { describe, expect, it } from "vitest";
import {
  describeTaskScopeViolations,
  matchesScopePattern,
  normalizeScopePath,
  validateTaskScope,
} from "../src/index.js";
import type { TaskScope } from "@agentic-dev-runner/core";

const scope = (allowed: string[], forbidden: string[]): TaskScope => ({
  allowedPaths: allowed,
  forbiddenPaths: forbidden,
});

describe("task scope validation", () => {
  it("accepts a changed path inside the allowed scope", () => {
    const result = validateTaskScope(
      ["src/features/auth/login.ts"],
      scope(["src/**"], []),
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects a changed path outside the allowed scope", () => {
    const result = validateTaskScope(
      ["backend/server.py"],
      scope(["src/**"], []),
    );
    if (result.ok) {
      throw new Error("expected validation to fail");
    }
    expect(result.violations).toEqual([
      { path: "backend/server.py", kind: "not-allowed" },
    ]);
  });

  it("rejects a path matched by forbidden_paths even when also allowed", () => {
    const result = validateTaskScope(
      ["src/generated/schema.ts"],
      scope(["src/**"], ["src/generated/**"]),
    );
    if (result.ok) {
      throw new Error("expected validation to fail");
    }
    expect(result.violations).toEqual([
      {
        path: "src/generated/schema.ts",
        kind: "forbidden",
        pattern: "src/generated/**",
      },
    ]);
  });

  it("reports every violating path deterministically", () => {
    const result = validateTaskScope(
      ["z-root.txt", "src/ok.ts", "docs/readme.md", "a/first.md", "z-root.txt"],
      scope(["src/**"], ["docs/**"]),
    );
    if (result.ok) {
      throw new Error("expected validation to fail");
    }
    expect(result.violations.map((violation) => violation.path)).toEqual([
      "a/first.md",
      "docs/readme.md",
      "z-root.txt",
    ]);
    expect(result.violations.map((violation) => violation.kind)).toEqual([
      "not-allowed",
      "forbidden",
      "not-allowed",
    ]);
    expect(describeTaskScopeViolations(result.violations)).toBe(
      'a/first.md (no allowed path pattern matched); docs/readme.md (forbidden by "docs/**"); z-root.txt (no allowed path pattern matched)',
    );
  });

  it("validates additions, modifications, and deletions uniformly as changed paths", () => {
    const result = validateTaskScope(
      ["src/new-file.ts", "src/existing.ts", "src/removed.ts"],
      scope(["src/**"], []),
    );
    expect(result).toEqual({ ok: true });
  });

  it("normalizes Windows-style host path separators before matching", () => {
    expect(matchesScopePattern("src\\utils.ts", "src/**")).toBe(true);
    expect(matchesScopePattern("docs\\secret.md", "docs/**")).toBe(true);
    expect(
      validateTaskScope(["docs\\secret.md"], scope(["src/**"], ["docs/**"]))
        .ok,
    ).toBe(false);
  });

  it("normalizes repository-relative paths without breaking matching", () => {
    expect(normalizeScopePath("src/utils.ts")).toBe("src/utils.ts");
    expect(normalizeScopePath(".\\src\\utils.ts")).toBe("src/utils.ts");
    expect(normalizeScopePath("/src/utils.ts")).toBe("src/utils.ts");
    expect(normalizeScopePath("")).toBe("");
  });

  it("matches whole-segment wildcards within a single segment", () => {
    expect(matchesScopePattern("src/utils.ts", "src/*.ts")).toBe(true);
    expect(matchesScopePattern("src/nested/utils.ts", "src/*.ts")).toBe(false);
    expect(matchesScopePattern("src/v1/report.ts", "src/v?/report.ts")).toBe(
      true,
    );
  });

  it("matches nested globs across multiple segments", () => {
    expect(matchesScopePattern("src/utils.ts", "src/**")).toBe(true);
    expect(matchesScopePattern("src/nested/utils.ts", "src/**")).toBe(true);
    expect(matchesScopePattern("srcx/utils.ts", "src/**")).toBe(false);
    expect(matchesScopePattern("test/a.test.ts", "test/**")).toBe(true);
    expect(matchesScopePattern("src/tmp.ts", "src/**/tmp.ts")).toBe(true);
    expect(matchesScopePattern("src/a/b/tmp.ts", "src/**/tmp.ts")).toBe(true);
    expect(matchesScopePattern("other/tmp.ts", "src/**/tmp.ts")).toBe(false);
    expect(matchesScopePattern("anything/anywhere/file.ts", "**")).toBe(true);
  });

  it("anchors patterns without slashes to file names at any depth", () => {
    expect(matchesScopePattern("README.md", "README.md")).toBe(true);
    expect(matchesScopePattern("docs/README.md", "README.md")).toBe(true);
    expect(matchesScopePattern("src/other.md", "*.md")).toBe(true);
    expect(matchesScopePattern("src/other.md", "README.md")).toBe(false);
  });

  it("matches directory patterns against everything beneath them", () => {
    expect(matchesScopePattern("src/utils.ts", "src/")).toBe(true);
    expect(matchesScopePattern("src/nested/utils.ts", "src/")).toBe(true);
    expect(matchesScopePattern("srcx/utils.ts", "src/")).toBe(false);
  });

  it("ignores empty and whitespace-only patterns", () => {
    expect(matchesScopePattern("src/utils.ts", "")).toBe(false);
    expect(
      validateTaskScope(["src/utils.ts"], scope(["", "  "], [])).ok,
    ).toBe(false);
  });

  it("treats an empty allowed list as rejecting every changed path", () => {
    const result = validateTaskScope(["src/utils.ts"], scope([], []));
    expect(result.ok).toBe(false);
  });

  it("validates untracked directory entries by the paths beneath them", () => {
    expect(matchesScopePattern("src/", "src/**")).toBe(true);
    expect(matchesScopePattern("docs/", "docs/**")).toBe(true);
    expect(matchesScopePattern("docs/", "src/**")).toBe(false);
    expect(matchesScopePattern("src/newpkg/", "src/")).toBe(true);
    expect(matchesScopePattern("src/", "src/exact-file.ts")).toBe(false);
    const allowed = validateTaskScope(
      ["src/newpkg/"],
      scope(["src/**"], []),
    );
    expect(allowed).toEqual({ ok: true });
    const forbidden = validateTaskScope(["docs/"], scope(["**"], ["docs/**"]));
    if (forbidden.ok) {
      throw new Error("expected validation to fail");
    }
    expect(forbidden.violations).toEqual([
      { path: "docs/", kind: "forbidden", pattern: "docs/**" },
    ]);
  });
});
