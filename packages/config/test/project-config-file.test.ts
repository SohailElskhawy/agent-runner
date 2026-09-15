import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProjectConfiguration } from "@agentic-dev-runner/config";

let projectRoot: string;

const CANONICAL_YAML = `verification:
  checks:
    typecheck:
      command: pnpm
      args:
        - typecheck

    unit:
      command: pnpm
      args:
        - test
`;

function configPath(): string {
  return join(projectRoot, "agentic.yaml");
}

describe("loadProjectConfiguration", () => {
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "agentic-runner-m016a-"));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("loads a valid canonical configuration", async () => {
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(configPath(), CANONICAL_YAML, "utf8");

    const result = await loadProjectConfiguration(projectRoot);

    expect(result).toEqual({
      ok: true,
      config: {
        verificationChecks: [
          { name: "typecheck", command: "pnpm", args: ["typecheck"] },
          { name: "unit", command: "pnpm", args: ["test"] },
        ],
      },
    });
  });

  it("loads multiple named checks with user-defined names", async () => {
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(
      configPath(),
      `verification:
  checks:
    typecheck:
      command: pnpm
      args:
        - typecheck
    unit:
      command: pnpm
      args:
        - test
    build:
      command: pnpm
      args:
        - build
    auth-integration:
      command: node
      args:
        - scripts/verify-auth.mjs
`,
      "utf8",
    );

    const result = await loadProjectConfiguration(projectRoot);

    if (!result.ok) {
      throw new Error(`expected load to succeed: ${JSON.stringify(result)}`);
    }
    expect(result.config.verificationChecks.map((check) => check.name)).toEqual(
      ["typecheck", "unit", "build", "auth-integration"],
    );
  });

  it("reports a distinguishable result when agentic.yaml is absent", async () => {
    const result = await loadProjectConfiguration(projectRoot);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("ABSENT");
    }
  });

  it("rejects malformed YAML as PARSE_FAILED", async () => {
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(
      configPath(),
      "verification:\n  checks:\n    typecheck:\n  [command: pnpm\n",
      "utf8",
    );

    const result = await loadProjectConfiguration(projectRoot);

    if (result.ok) {
      throw new Error("expected load to fail");
    }
    if (result.reason !== "PARSE_FAILED") {
      throw new Error(`expected PARSE_FAILED, got: ${result.reason}`);
    }
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("rejects duplicate YAML keys", async () => {
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(
      configPath(),
      `verification:
  checks:
    typecheck:
      command: pnpm
      args:
        - typecheck
    typecheck:
      command: pnpm
      args:
        - test
`,
      "utf8",
    );

    const result = await loadProjectConfiguration(projectRoot);

    if (result.ok) {
      throw new Error("expected load to fail");
    }
    expect(result.reason).toBe("PARSE_FAILED");
  });

  it("rejects unknown top-level fields as INVALID", async () => {
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(
      configPath(),
      `${CANONICAL_YAML}agents:\n  default: opencode\n`,
      "utf8",
    );

    const result = await loadProjectConfiguration(projectRoot);

    if (result.ok) {
      throw new Error("expected load to fail");
    }
    if (result.reason !== "INVALID") {
      throw new Error(`expected INVALID, got: ${result.reason}`);
    }
    expect(result.issues.join(" ")).toContain('unknown field "agents"');
  });

  it("rejects unknown fields inside verification and inside checks", async () => {
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(
      configPath(),
      `verification:
  workflow: default
  checks:
    typecheck:
      command: pnpm
      args:
        - typecheck
      timeoutMs: 30000
`,
      "utf8",
    );

    const result = await loadProjectConfiguration(projectRoot);

    if (result.ok) {
      throw new Error("expected load to fail");
    }
    if (result.reason !== "INVALID") {
      throw new Error(`expected INVALID, got: ${result.reason}`);
    }
    const joined = result.issues.join(" ");
    expect(joined).toContain('unknown field "workflow"');
    expect(joined).toContain('unknown field "timeoutMs"');
  });

  it("rejects an empty command and non-string args as INVALID", async () => {
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(
      configPath(),
      `verification:
  checks:
    typecheck:
      command: ""
      args:
        - typecheck
    unit:
      command: pnpm
      args:
        - test
        - 7
`,
      "utf8",
    );

    const result = await loadProjectConfiguration(projectRoot);

    if (result.ok) {
      throw new Error("expected load to fail");
    }
    if (result.reason !== "INVALID") {
      throw new Error(`expected INVALID, got: ${result.reason}`);
    }
    const joined = result.issues.join(" ");
    expect(joined).toContain(
      "project configuration.verification.checks.typecheck.command: must be a non-empty string",
    );
    expect(joined).toContain(
      "project configuration.verification.checks.unit.args[1]: must be a string",
    );
  });

  it("preserves command plus argument-array semantics without shell strings", async () => {
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(
      configPath(),
      `verification:
  checks:
    auth-integration:
      command: node
      args:
        - scripts/verify-auth.mjs
        - --suite
        - auth-integration
`,
      "utf8",
    );

    const result = await loadProjectConfiguration(projectRoot);

    if (!result.ok) {
      throw new Error(`expected load to succeed: ${JSON.stringify(result)}`);
    }
    expect(result.config.verificationChecks).toEqual([
      {
        name: "auth-integration",
        command: "node",
        args: ["scripts/verify-auth.mjs", "--suite", "auth-integration"],
      },
    ]);
  });

  it("treats a non-readable configuration entry as READ_FAILED", async () => {
    mkdirSync(configPath(), { recursive: true });

    const result = await loadProjectConfiguration(projectRoot);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("READ_FAILED");
    }
  });
});
