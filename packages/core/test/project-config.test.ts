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
        agents: { default: "opencode" },
      }),
    );
    expect(issues.join(" ")).toContain('unknown field "agents"');
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
