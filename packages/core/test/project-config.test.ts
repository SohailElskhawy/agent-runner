import { describe, expect, it } from "vitest";
import {
  validateProjectConfiguration,
  type ProjectConfigurationValidationResult,
} from "@agentic-dev-runner/core";

function canonicalConfig(): Record<string, unknown> {
  return { verification: canonicalVerification() };
}

function canonicalVerification(): { checks: Record<string, unknown> } {
  return {
    checks: {
      typecheck: {
        command: "pnpm",
        args: ["typecheck"],
      },
      unit: {
        command: "pnpm",
        args: ["test"],
      },
    },
  };
}

function validate(input: unknown) {
  const result = validateProjectConfiguration(input);
  if (!result.ok) {
    throw new Error(`unexpected validation issues: ${result.issues.join("; ")}`);
  }
  return result.value;
}

function expectIssues(
  result: ProjectConfigurationValidationResult,
): readonly string[] {
  if (result.ok) {
    throw new Error("expected validation to fail");
  }
  expect(result.issues.length).toBeGreaterThan(0);
  return result.issues;
}

describe("validateProjectConfiguration", () => {
  it("accepts the canonical configuration shape", () => {
    const value = validate(canonicalConfig());
    expect(value.verificationChecks).toHaveLength(2);
    expect(value.verificationChecks).toEqual([
      { name: "typecheck", command: "pnpm", args: ["typecheck"] },
      { name: "unit", command: "pnpm", args: ["test"] },
    ]);
  });

  it("normalizes into a representation-independent result", () => {
    const input = canonicalConfig();
    const value = validate(input);
    expect(value).toEqual({
      agentProfiles: [],
      verificationChecks: [
        { name: "typecheck", command: "pnpm", args: ["typecheck"] },
        { name: "unit", command: "pnpm", args: ["test"] },
      ],
    });
    expect(value).not.toBe(input);
  });

  it("accepts a single check with user-defined names and empty args", () => {
    const value = validate({
      verification: {
        checks: {
          "auth-integration": {
            command: "pnpm",
            args: [],
          },
        },
      },
    });
    expect(value.verificationChecks).toEqual([
      { name: "auth-integration", command: "pnpm", args: [] },
    ]);
  });

  it("rejects non-object input", () => {
    for (const input of [null, undefined, "config", 7, [], true]) {
      const issues = expectIssues(validateProjectConfiguration(input));
      expect(issues.join(" ")).toContain("must be an object");
    }
  });

  it("rejects unknown top-level fields", () => {
    const issues = expectIssues(
      validateProjectConfiguration({
        verification: canonicalVerification(),
        workflows: { default: "manual" },
      }),
    );
    expect(issues.join(" ")).toContain('unknown field "workflows"');
  });

  it("rejects unknown fields inside verification", () => {
    const issues = expectIssues(
      validateProjectConfiguration({
        verification: {
          checks: canonicalVerification().checks,
          workflow: "default",
        },
      }),
    );
    expect(issues.join(" ")).toContain('unknown field "workflow"');
  });

  it("rejects unknown fields inside a check", () => {
    const input = canonicalConfig();
    const checks = (input.verification as { checks: Record<string, unknown> })
      .checks;
    checks["typecheck"] = {
      command: "pnpm",
      args: ["typecheck"],
      timeoutMs: 30000,
    };
    const issues = expectIssues(validateProjectConfiguration(input));
    expect(issues.join(" ")).toContain('unknown field "timeoutMs"');
  });

  it("rejects empty or blank commands", () => {
    for (const command of ["", "   ", null, 7, undefined]) {
      const input = canonicalConfig();
      const checks = (input.verification as { checks: Record<string, unknown> })
      .checks;
      checks["typecheck"] = { command, args: ["typecheck"] };
      const issues = expectIssues(validateProjectConfiguration(input));
      expect(issues.join(" ")).toContain(
        "project configuration.verification.checks.typecheck.command: must be a non-empty string",
      );
    }
  });

  it("rejects missing args and non-array args", () => {
    for (const args of [undefined, "typecheck", { index: 0 }, null]) {
      const input = canonicalConfig();
      const checks = (input.verification as { checks: Record<string, unknown> })
      .checks;
      checks["typecheck"] = { command: "pnpm", args };
      const issues = expectIssues(validateProjectConfiguration(input));
      expect(issues.join(" ")).toContain(
        "project configuration.verification.checks.typecheck.args: must be an array of strings",
      );
    }
  });

  it("rejects non-string arguments", () => {
    for (const entry of [7, null, true, { flag: "--all" }, undefined]) {
      const input = canonicalConfig();
      const checks = (input.verification as { checks: Record<string, unknown> })
      .checks;
      checks["typecheck"] = { command: "pnpm", args: [entry] };
      const issues = expectIssues(validateProjectConfiguration(input));
      expect(issues.join(" ")).toContain(
        "project configuration.verification.checks.typecheck.args[0]: must be a string",
      );
    }
  });

  it("rejects non-object check values", () => {
    const input = canonicalConfig();
    const checks = (input.verification as { checks: Record<string, unknown> })
      .checks;
    checks["typecheck"] = "pnpm typecheck";
    const issues = expectIssues(validateProjectConfiguration(input));
    expect(issues.join(" ")).toContain(
      "project configuration.verification.checks.typecheck: must be an object",
    );
  });

  it("rejects missing verification section, missing checks, and empty checks", () => {
    const missingVerification = expectIssues(validateProjectConfiguration({}));
    expect(missingVerification.join(" ")).toContain(
      "project configuration.verification: must be an object with named checks",
    );

    const missingChecks = expectIssues(
      validateProjectConfiguration({ verification: {} }),
    );
    expect(missingChecks.join(" ")).toContain(
      "project configuration.verification.checks: must be an object mapping check names to checks",
    );

    const emptyChecks = expectIssues(
      validateProjectConfiguration({ verification: { checks: {} } }),
    );
    expect(emptyChecks.join(" ")).toContain("must contain at least one check");
  });

  it("rejects empty check names", () => {
    const input = canonicalConfig();
    const checks = (input.verification as { checks: Record<string, unknown> })
      .checks;
    checks[""] = { command: "pnpm", args: [] };
    const issues = expectIssues(validateProjectConfiguration(input));
    expect(issues.join(" ")).toContain("must be a non-empty string name");
  });
});

describe("validateProjectConfiguration agent profiles", () => {
  function canonicalAgents(): Record<string, unknown> {
    return {
      agents: {
        profiles: {
          "codex-default": {
            adapter: "codex",
            model: "gpt-5-codex",
            capabilities: ["TypeScript", "Debugging"],
          },
          "opencode-default": {
            adapter: "opencode",
            capabilities: ["typescript"],
          },
        },
      },
    };
  }

  function validate(input: unknown) {
    const result = validateProjectConfiguration(input);
    if (!result.ok) {
      throw new Error(`unexpected validation issues: ${result.issues.join("; ")}`);
    }
    return result.value;
  }

  function expectIssues(
    result: ProjectConfigurationValidationResult,
  ): readonly string[] {
    if (result.ok) {
      throw new Error("expected validation to fail");
    }
    expect(result.issues.length).toBeGreaterThan(0);
    return result.issues;
  }

  it("accepts verification plus agent profiles and normalizes into AgentProfile values", () => {
    const value = validate({ verification: canonicalVerification(), ...canonicalAgents() });
    expect(value.agentProfiles).toEqual([
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

  it("preserves profile declaration order", () => {
    const profiles = (canonicalAgents().agents as {
      profiles: Record<string, unknown>;
    }).profiles;
    const value = validate({
      verification: canonicalVerification(),
      agents: {
        profiles: {
          "zeta-agent": profiles["opencode-default"],
          "alpha-agent": profiles["codex-default"],
        },
      },
    });
    expect(value.agentProfiles.map((candidate) => candidate.id)).toEqual([
      "zeta-agent",
      "alpha-agent",
    ]);
  });

  it("omits the optional model when not declared", () => {
    const value = validate({ verification: canonicalVerification(), ...canonicalAgents() });
    const second = value.agentProfiles[1];
    expect(second).toBeDefined();
    if (second === undefined) {
      throw new Error("expected second profile");
    }
    expect("model" in second).toBe(false);
  });

  it("accepts empty capabilities", () => {
    const value = validate({
      verification: canonicalVerification(),
      agents: {
        profiles: {
          "no-capabilities": { adapter: "opencode", capabilities: [] },
        },
      },
    });
    expect(value.agentProfiles).toEqual([
      { id: "no-capabilities", adapterId: "opencode", capabilities: [] },
    ]);
  });

  it("treats agents as optional", () => {
    const value = validate(canonicalConfig());
    expect(value.agentProfiles).toEqual([]);
  });

  it("rejects blank profile ids", () => {
    for (const id of ["", "   "]) {
      const issues = expectIssues(
        validateProjectConfiguration({
          verification: canonicalVerification(),
          agents: {
            profiles: { [id]: { adapter: "opencode", capabilities: [] } },
          },
        }),
      );
      expect(issues.join(" ")).toContain("must be a non-empty string profile id");
    }
  });

  it("rejects blank adapter ids", () => {
    for (const adapter of ["", "   ", null, 7, undefined]) {
      const issues = expectIssues(
        validateProjectConfiguration({
          verification: canonicalVerification(),
          agents: {
            profiles: { "agent-1": { adapter, capabilities: ["typescript"] } },
          },
        }),
      );
      expect(issues.join(" ")).toContain(
        "adapterId: must be a non-empty string",
      );
    }
  });

  it("rejects invalid optional model values", () => {
    for (const model of ["", "   ", null, 7, true]) {
      const issues = expectIssues(
        validateProjectConfiguration({
          verification: canonicalVerification(),
          agents: {
            profiles: {
              "agent-1": {
                adapter: "opencode",
                model,
                capabilities: ["typescript"],
              },
            },
          },
        }),
      );
      expect(issues.join(" ")).toContain("model: must be a non-empty string");
    }
  });

  it("rejects non-string and blank capabilities", () => {
    for (const capability of [7, null, true, "   ", { label: "typescript" }]) {
      const issues = expectIssues(
        validateProjectConfiguration({
          verification: canonicalVerification(),
          agents: {
            profiles: {
              "agent-1": { adapter: "opencode", capabilities: [capability] },
            },
          },
        }),
      );
      expect(issues.join(" ")).toContain(
        "capabilities[0]: must be a non-empty string",
      );
    }
  });

  it("rejects capabilities that are duplicates after normalization", () => {
    const issues = expectIssues(
      validateProjectConfiguration({
        verification: canonicalVerification(),
        agents: {
          profiles: {
            "agent-1": {
              adapter: "opencode",
              capabilities: ["TypeScript", "typescript"],
            },
          },
        },
      }),
    );
    expect(issues.join(" ")).toContain(
      'duplicate capability "typescript"',
    );
  });

  it("rejects missing capabilities", () => {
    const issues = expectIssues(
      validateProjectConfiguration({
        verification: canonicalVerification(),
        agents: {
          profiles: { "agent-1": { adapter: "opencode" } },
        },
      }),
    );
    expect(issues.join(" ")).toContain(
      "capabilities: must be an array of capability labels",
    );
  });

  it("rejects unknown fields under agents and under a profile declaration", () => {
    const issues = expectIssues(
      validateProjectConfiguration({
        verification: canonicalVerification(),
        agents: {
          default: "opencode",
          profiles: {
            "agent-1": {
              adapter: "opencode",
              capabilities: ["typescript"],
              timeoutMs: 30000,
            },
          },
        },
      }),
    );
    const joined = issues.join(" ");
    expect(joined).toContain('unknown field "default"');
    expect(joined).toContain('unknown field "timeoutMs"');
  });

  it("rejects malformed agents and profiles structures", () => {
    for (const agents of ["opencode", 7, [], true, null]) {
      const issues = expectIssues(
        validateProjectConfiguration({
          verification: canonicalVerification(),
          agents,
        }),
      );
      expect(issues.join(" ")).toContain("project configuration.agents: must be an object");
    }

    for (const profiles of ["opencode", 7, [], true, null]) {
      const issues = expectIssues(
        validateProjectConfiguration({
          verification: canonicalVerification(),
          agents: { profiles },
        }),
      );
      expect(issues.join(" ")).toContain(
        "project configuration.agents.profiles: must be an object mapping profile ids to profiles",
      );
    }

    for (const declaration of ["opencode", 7, [], true, null]) {
      const issues = expectIssues(
        validateProjectConfiguration({
          verification: canonicalVerification(),
          agents: { profiles: { "agent-1": declaration } },
        }),
      );
      expect(issues.join(" ")).toContain(
        "project configuration.agents.profiles.agent-1: must be an object",
      );
    }
  });
});
