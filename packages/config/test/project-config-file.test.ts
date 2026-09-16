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
        agentProfiles: [],
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
      `${CANONICAL_YAML}agents:\n  profiles: {}\n\ncustom-tooling:\n  enabled: true\n`,
      "utf8",
    );

    const result = await loadProjectConfiguration(projectRoot);

    if (result.ok) {
      throw new Error("expected load to fail");
    }
    if (result.reason !== "INVALID") {
      throw new Error(`expected INVALID, got: ${result.reason}`);
    }
    expect(result.issues.join(" ")).toContain('unknown field "custom-tooling"');
  });

  it("rejects unknown fields under agents as INVALID", async () => {
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
    expect(result.issues.join(" ")).toContain(
      'project configuration.agents: unknown field "default"',
    );
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

describe("loadProjectConfiguration agent profiles", () => {
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "agentic-runner-m016b-"));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const CANONICAL_AGENTS_YAML = `verification:
  checks:
    typecheck:
      command: pnpm
      args:
        - typecheck

agents:
  profiles:
    codex-default:
      adapter: codex
      model: gpt-5-codex
      capabilities:
        - typescript
        - debugging

    opencode-default:
      adapter: opencode
      capabilities:
        - typescript
`;

  it("loads combined verification and agents configuration with valid AgentProfile values", async () => {
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(configPath(), CANONICAL_AGENTS_YAML, "utf8");

    const result = await loadProjectConfiguration(projectRoot);

    if (!result.ok) {
      throw new Error(`expected load to succeed: ${JSON.stringify(result)}`);
    }
    expect(result.config.verificationChecks).toEqual([
      { name: "typecheck", command: "pnpm", args: ["typecheck"] },
    ]);
    expect(result.config.agentProfiles).toEqual([
      {
        id: "codex-default",
        adapterId: "codex",
        model: "gpt-5-codex",
        capabilities: ["typescript", "debugging"],
      },
      {
        id: "opencode-default",
        adapterId: "opencode",
        capabilities: ["typescript"],
      },
    ]);
  });

  it("loads a single valid profile", async () => {
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(
      configPath(),
      `verification:
  checks:
    typecheck:
      command: pnpm
      args:
        - typecheck

agents:
  profiles:
    codex-default:
      adapter: codex
      model: gpt-5-codex
      capabilities:
        - typescript
`,
      "utf8",
    );

    const result = await loadProjectConfiguration(projectRoot);

    if (!result.ok) {
      throw new Error(`expected load to succeed: ${JSON.stringify(result)}`);
    }
    expect(result.config.agentProfiles).toEqual([
      {
        id: "codex-default",
        adapterId: "codex",
        model: "gpt-5-codex",
        capabilities: ["typescript"],
      },
    ]);
  });

  it("preserves profile declaration order deterministically", async () => {
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(
      configPath(),
      `verification:
  checks:
    typecheck:
      command: pnpm
      args:
        - typecheck

agents:
  profiles:
    zeta-agent:
      adapter: opencode
      capabilities:
        - typescript
    alpha-agent:
      adapter: codex
      capabilities:
        - debugging
    mid-agent:
      adapter: opencode
      capabilities:
        - debugging
`,
      "utf8",
    );

    const result = await loadProjectConfiguration(projectRoot);

    if (!result.ok) {
      throw new Error(`expected load to succeed: ${JSON.stringify(result)}`);
    }
    expect(result.config.agentProfiles.map((profile) => profile.id)).toEqual([
      "zeta-agent",
      "alpha-agent",
      "mid-agent",
    ]);
  });

  it("normalizes capability labels through the core AgentProfile rules", async () => {
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(
      configPath(),
      `verification:
  checks:
    typecheck:
      command: pnpm
      args:
        - typecheck

agents:
  profiles:
    agent-1:
      adapter: opencode
      capabilities:
        - "  TypeScript "
        - REACT-NATIVE
`,
      "utf8",
    );

    const result = await loadProjectConfiguration(projectRoot);

    if (!result.ok) {
      throw new Error(`expected load to succeed: ${JSON.stringify(result)}`);
    }
    const firstProfile = result.config.agentProfiles[0];
    expect(firstProfile).toBeDefined();
    expect(firstProfile?.capabilities).toEqual([
      "typescript",
      "react-native",
    ]);
  });

  it("rejects normalization-equivalent duplicate capabilities as INVALID", async () => {
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(
      configPath(),
      `agents:
  profiles:
    agent-1:
      adapter: opencode
      capabilities:
        - TypeScript
        - typescript
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
    expect(result.issues.join(" ")).toContain(
      'duplicate capability "typescript"',
    );
  });

  it("rejects invalid adapter, model, and capability values as INVALID", async () => {
    const cases: readonly string[] = [
      `agents:
  profiles:
    agent-1:
      adapter: "   "
      capabilities:
        - typescript
`,
      `agents:
  profiles:
    agent-1:
      adapter: opencode
      model: 7
      capabilities:
        - typescript
`,
      `agents:
  profiles:
    agent-1:
      adapter: opencode
      capabilities:
        - 7
`,
      `agents:
  profiles:
    agent-1:
      adapter: opencode
      capabilities:
        - "   "
`,
    ];

    for (const source of cases) {
      mkdirSync(projectRoot, { recursive: true });
      writeFileSync(configPath(), source, "utf8");

      const result = await loadProjectConfiguration(projectRoot);

      if (result.ok) {
        throw new Error(`expected load to fail for: ${JSON.stringify(source)}`);
      }
      if (result.reason !== "INVALID") {
        throw new Error(`expected INVALID, got: ${result.reason}`);
      }
      expect(result.issues.length).toBeGreaterThan(0);
      rmSync(configPath(), { force: true });
    }
  });

  it("rejects malformed agents and profiles structures as INVALID", async () => {
    const cases: readonly string[] = [
      `${CANONICAL_YAML}agents: opencode\n`,
      `${CANONICAL_YAML}agents:\n  profiles: opencode\n`,
      `${CANONICAL_YAML}agents:\n  profiles:\n    - codex\n`,
      `${CANONICAL_YAML}agents:\n  profiles:\n    agent-1: codex\n`,
      `${CANONICAL_YAML}agents:\n  profiles:\n    "":\n      adapter: opencode\n      capabilities:\n        - typescript\n`,
      `${CANONICAL_YAML}agents:\n  profiles:\n    "   ":\n      adapter: opencode\n      capabilities:\n        - typescript\n`,
    ];

    for (const source of cases) {
      writeFileSync(configPath(), source, "utf8");

      const result = await loadProjectConfiguration(projectRoot);

      if (result.ok) {
        throw new Error(`expected load to fail for: ${JSON.stringify(source)}`);
      }
      if (result.reason !== "INVALID") {
        throw new Error(`expected INVALID, got: ${result.reason}`);
      }
      expect(result.issues.length).toBeGreaterThan(0);
      rmSync(configPath(), { force: true });
    }
  });

  it("rejects unknown fields inside a profile declaration as INVALID", async () => {
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(
      configPath(),
      `agents:
  profiles:
    agent-1:
      adapter: opencode
      capabilities:
        - typescript
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
    expect(result.issues.join(" ")).toContain('unknown field "timeoutMs"');
  });
});
