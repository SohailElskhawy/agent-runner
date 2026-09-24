import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctorChecks } from "../src/application/doctor.js";
import type { DoctorReport } from "../src/application/doctor.js";
import type { RunnerAppService } from "../src/application/runner-app-service.js";
import { runCli } from "../src/run-cli.js";
import { createServices } from "../src/wiring.js";
import {
  captureIo,
  createFixtureProject,
  createFixtureRepository,
  temporaryDirectory,
  writeProjectConfiguration,
} from "./fixtures.js";

function doctorOnlyService(report: DoctorReport): RunnerAppService {
  const unexpected = (): never => {
    throw new Error("doctor test service received an unexpected application call");
  };
  return {
    init: unexpected,
    addTask: unexpected,
    approve: unexpected,
    retry: unexpected,
    run: unexpected,
    runUnattended: unexpected,
    status: unexpected,
    listTaskSummaries: unexpected,
    inspect: unexpected,
    listAgents: unexpected,
    doctor: async () => report,
    close: async () => {},
  };
}

/** Points the per-user state directory at a temporary home on every platform. */
function overrideHome(directory: string): () => void {
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  process.env.HOME = directory;
  process.env.USERPROFILE = directory;
  return () => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousProfile;
    }
  };
}

describe("runDoctorChecks", () => {
  it("reports FAIL for an unsupported node version and missing git", async () => {
    const report = await runDoctorChecks({
      nodeVersion: "22.14.0",
      projectRoot: "/repo",
      storePath: "/state/state.db",
      worktreesDir: "/state/worktrees",
      configuration: null,
      configurationError: null,
      projects: [],
      agents: [],
      runGitVersion: async () => ({ ok: false, detail: "git is not on PATH" }),
      ensureWorktreesDir: async () => ({ ok: true, detail: "writable" }),
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === "node")?.status).toBe("FAIL");
    expect(report.checks.find((check) => check.name === "git")?.status).toBe("FAIL");
    expect(report.checks.find((check) => check.name === "project")?.status).toBe("WARN");
    expect(report.checks.find((check) => check.name === "configuration")?.status).toBe("WARN");
    expect(report.checks.find((check) => check.name === "agents")?.status).toBe("WARN");
  });

  it("passes when the environment is healthy", async () => {
    const report = await runDoctorChecks({
      nodeVersion: "24.11.0",
      projectRoot: "/repo",
      storePath: "/state/state.db",
      worktreesDir: "/state/worktrees",
      configuration: { verificationChecks: [], agentProfiles: [] },
      configurationError: null,
      projects: [createFixtureProject()],
      agents: [
        { id: "opencode", available: true, version: "1.0.0", reason: null },
      ],
      runGitVersion: async () => ({ ok: true, detail: "git version 2.50.0" }),
      ensureWorktreesDir: async () => ({ ok: true, detail: "writable" }),
    });
    expect(report.ok).toBe(true);
    expect(report.checks.every((check) => check.status === "PASS")).toBe(true);
  });

  it("reports FAIL when the project configuration could not be loaded", async () => {
    const report = await runDoctorChecks({
      nodeVersion: "24.11.0",
      projectRoot: "/repo",
      storePath: "/state/state.db",
      worktreesDir: "/state/worktrees",
      configuration: null,
      configurationError: "agentic.yaml is invalid: unknown key",
      projects: [createFixtureProject()],
      agents: [
        { id: "opencode", available: true, version: "1.0.0", reason: null },
      ],
      runGitVersion: async () => ({ ok: true, detail: "git version 2.50.0" }),
      ensureWorktreesDir: async () => ({ ok: true, detail: "writable" }),
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === "configuration")?.status).toBe(
      "FAIL",
    );
  });
});

describe("agentic doctor", () => {
  it("exits zero and reports PASS for node and git against a wired project", async () => {
    const directory = temporaryDirectory("agentic-cli-doctor");
    const repositoryPath = join(directory, "repo");
    const restoreHome = overrideHome(join(directory, "home"));
    try {
      await createFixtureRepository(repositoryPath, "# Fixture rules\n");
      writeProjectConfiguration(repositoryPath);
      const { io, lines } = captureIo();

      const exitCode = await runCli(["doctor"], {
        io,
        servicesFactory: () => createServices(repositoryPath),
      });

      const output = lines.join("\n");
      expect(exitCode).toBe(0);
      expect(output).toContain("[PASS] node");
      expect(output).toContain("[PASS] git");
      expect(output).toContain("[PASS] worktrees");
    } finally {
      restoreHome();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("exits one when a check fails", async () => {
    const { io, lines } = captureIo();
    const exitCode = await runCli(["doctor"], {
      io,
      servicesFactory: () =>
        doctorOnlyService({
          checks: [{ name: "git", status: "FAIL", detail: "git is not on PATH" }],
          ok: false,
        }),
    });

    expect(exitCode).toBe(1);
    expect(lines.join("\n")).toContain("[FAIL] git");
  });

  it("rejects extra arguments with usage output", async () => {
    const { io, errors } = captureIo();
    const exitCode = await runCli(["doctor", "extra"], {
      io,
      servicesFactory: () => doctorOnlyService({ checks: [], ok: true }),
    });

    expect(exitCode).toBe(2);
    expect(errors.join("\n")).toContain("does not accept extra arguments");
  });
});
