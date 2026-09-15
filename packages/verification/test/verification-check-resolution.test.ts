import { describe, expect, it } from "vitest";
import {
  resolveVerificationChecksForTask,
  toVerificationCheckSpecs,
} from "../src/index.js";

describe("toVerificationCheckSpecs", () => {
  it("maps configured commands and argument arrays to verification specs", () => {
    const specs = toVerificationCheckSpecs([
      { name: "typecheck", command: "pnpm", args: ["typecheck"] },
      { name: "unit", command: "node", args: ["--test", "test/**/*.test.cjs"] },
    ]);

    expect(specs).toEqual([
      { name: "typecheck", executable: "pnpm", args: ["typecheck"] },
      {
        name: "unit",
        executable: "node",
        args: ["--test", "test/**/*.test.cjs"],
      },
    ]);
  });

  it("does not alias the configured argument arrays", () => {
    const args = ["typecheck"];
    const specs = toVerificationCheckSpecs([
      { name: "typecheck", command: "pnpm", args },
    ]);
    (specs[0]?.args as string[]).push("mutated");
    expect(args).toEqual(["typecheck"]);
  });
});

describe("resolveVerificationChecksForTask", () => {
  const configured = [
    { name: "typecheck", executable: "pnpm", args: ["typecheck"] },
    { name: "unit", executable: "pnpm", args: ["test"] },
    { name: "build", executable: "pnpm", args: ["build"] },
  ];

  it("resolves required checks in the task-declared order", () => {
    const resolution = resolveVerificationChecksForTask(
      ["unit", "build", "typecheck"],
      configured,
    );

    expect(resolution).toEqual({
      ok: true,
      checks: [
        { name: "unit", executable: "pnpm", args: ["test"] },
        { name: "build", executable: "pnpm", args: ["build"] },
        { name: "typecheck", executable: "pnpm", args: ["typecheck"] },
      ],
    });
  });

  it("resolves a single required check", () => {
    const resolution = resolveVerificationChecksForTask(["unit"], configured);

    expect(resolution).toEqual({
      ok: true,
      checks: [{ name: "unit", executable: "pnpm", args: ["test"] }],
    });
  });

  it("reports every missing required check deterministically", () => {
    const resolution = resolveVerificationChecksForTask(
      ["typecheck", "lint", "e2e", "lint"],
      configured,
    );

    expect(resolution).toEqual({
      ok: false,
      missingChecks: ["lint", "e2e", "lint"],
    });
  });

  it("reports missing checks instead of falling back to unrelated configured checks", () => {
    const resolution = resolveVerificationChecksForTask(
      ["custom-security"],
      configured,
    );

    expect(resolution).toEqual({
      ok: false,
      missingChecks: ["custom-security"],
    });
  });
});
