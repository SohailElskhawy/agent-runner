import { execFileSync } from "node:child_process";
import type { ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const BUNDLE = join(PACKAGE_DIR, "bundle", "main.js");
const STAGED_DOCUMENTS = ["README.md", "LICENSE", "THIRD-PARTY-NOTICES.md"] as const;
const AGENT_FIXTURE = fileURLToPath(
  new URL("./fixtures/fake-pack-agent.mjs", import.meta.url),
);
const TARBALL_ENTRIES = [
  "package/bundle/main.js",
  "package/README.md",
  "package/LICENSE",
  "package/THIRD-PARTY-NOTICES.md",
] as const;
const enabled = process.env["AGENTIC_PACK_SMOKE"] === "1";

type PnpmInvocation = {
  readonly executable: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments?: true | undefined;
};

function quoteCmdToken(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function pnpmInvocation(args: readonly string[]): PnpmInvocation {
  const execPath = process.env["npm_execpath"];
  if (execPath === undefined || execPath.length === 0) {
    throw new Error(
      "AGENTIC_PACK_SMOKE requires npm_execpath; run this test through pnpm",
    );
  }
  if (/\.(?:cmd|bat)$/i.test(execPath)) {
    const command = [execPath, ...args].map(quoteCmdToken).join(" ");
    return {
      executable: process.env["ComSpec"] ?? "cmd.exe",
      args: ["/d", "/s", "/c", `"${command}"`],
      windowsVerbatimArguments: true,
    };
  }
  return /\.(?:cjs|mjs|js)$/i.test(execPath)
    ? { executable: process.execPath, args: [execPath, ...args] }
    : { executable: execPath, args: [...args] };
}

function runPnpm(args: readonly string[], cwd: string): string {
  const invocation = pnpmInvocation(args);
  const options: ExecFileSyncOptionsWithStringEncoding & {
    windowsVerbatimArguments?: true;
  } =
    invocation.windowsVerbatimArguments === true
      ? {
          cwd,
          encoding: "utf8",
          windowsVerbatimArguments: true,
          windowsHide: true,
        }
      : { cwd, encoding: "utf8", windowsHide: true };
  return execFileSync(invocation.executable, [...invocation.args], options);
}

function resolveTarball(packOutput: string, directory: string): string {
  const reported = packOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .reverse()
    .find((line) => line.endsWith(".tgz"));
  if (reported === undefined) {
    throw new Error(`pnpm pack did not report a tarball path:\n${packOutput}`);
  }
  return isAbsolute(reported) ? reported : join(directory, reported);
}

function runGit(repository: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: repository, encoding: "utf8" });
}

function initializeFixtureRepository(repository: string): void {
  runGit(repository, ["init"]);
  runGit(repository, ["config", "user.email", "runner@example.com"]);
  runGit(repository, ["config", "user.name", "Agentic Runner Fixture"]);
  runGit(repository, ["config", "core.autocrlf", "false"]);
  runGit(repository, ["add", "."]);
  runGit(repository, ["commit", "-m", "initial commit"]);
}

describe.skipIf(!enabled)("packed CLI smoke", () => {
  let directory: string | undefined;

  beforeAll(() => {
    execFileSync(process.execPath, [join(PACKAGE_DIR, "scripts", "bundle.mjs")], {
      cwd: PACKAGE_DIR,
    });
    expect(existsSync(BUNDLE), `bundle build produced no ${BUNDLE}`).toBe(true);
    for (const stagedDocument of STAGED_DOCUMENTS) {
      rmSync(join(PACKAGE_DIR, stagedDocument), { force: true });
    }
  });

  afterAll(() => {
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("installs the tarball and runs a task end to end", () => {
    directory = mkdtempSync(join(tmpdir(), "agentic-pack-smoke-"));
    const workDir = directory;

    const packOutput = runPnpm(
      ["pack", "--pack-destination", workDir],
      PACKAGE_DIR,
    );
    const tarball = resolveTarball(packOutput, workDir);
    expect(existsSync(tarball), `packed tarball missing: ${tarball}`).toBe(true);

    const consumerDir = join(workDir, "consumer");
    mkdirSync(consumerDir, { recursive: true });
    writeFileSync(
      join(consumerDir, "package.json"),
      JSON.stringify(
        { name: "pack-smoke-consumer", private: true, version: "0.0.0" },
        null,
        2,
      ),
    );
    runPnpm(["add", tarball], consumerDir);

    const installedDir = join(consumerDir, "node_modules", "agentic-dev-runner");
    const cli = join(installedDir, "bundle", "main.js");
    const binName = process.platform === "win32" ? "agentic.cmd" : "agentic";
    expect(
      existsSync(join(consumerDir, "node_modules", ".bin", binName)),
      `published bin "${binName}" was not linked into node_modules/.bin`,
    ).toBe(true);

    const listing = execFileSync("tar", ["-tzf", basename(tarball)], {
      cwd: workDir,
      encoding: "utf8",
    });
    const entries = listing.split(/\r?\n/);
    for (const entry of TARBALL_ENTRIES) {
      expect(entries, `tarball is missing ${entry}`).toContain(entry);
    }

    const installedManifest = JSON.parse(
      readFileSync(join(installedDir, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(installedManifest).not.toHaveProperty("dependencies");

    const repository = join(workDir, "fixture repo");
    mkdirSync(repository, { recursive: true });
    writeFileSync(join(repository, "AGENTS.md"), "# Fixture rules\n");
    writeFileSync(
      join(repository, "agentic.yaml"),
      [
        "verification:",
        "  checks:",
        "    unit:",
        "      command: node",
        "      args:",
        "        - --test",
        "        - test/**/*.test.cjs",
        "agents:",
        "  profiles:",
        "    opencode:",
        "      adapter: opencode",
        "      capabilities:",
        "        - javascript",
        "",
      ].join("\n"),
    );
    writeFileSync(join(repository, "README.md"), "fixture\n");
    initializeFixtureRepository(repository);

    const shimDir = join(workDir, "shims");
    mkdirSync(shimDir, { recursive: true });
    const agent = join(workDir, "fake-pack-agent.mjs");
    cpSync(AGENT_FIXTURE, agent);
    if (process.platform === "win32") {
      writeFileSync(join(shimDir, "opencode.cmd"), `@echo off\r\nnode "${agent}" %*\r\n`);
    } else {
      const shim = join(shimDir, "opencode");
      writeFileSync(shim, `#!/bin/sh\nexec node "${agent}" "$@"\n`);
      chmodSync(shim, 0o755);
    }

    const home = join(workDir, "home");
    mkdirSync(home, { recursive: true });
    const env = {
      ...process.env,
      PATH: `${shimDir}${delimiter}${process.env["PATH"] ?? ""}`,
      HOME: home,
      USERPROFILE: home,
    };

    const run = (args: readonly string[]): string =>
      execFileSync(process.execPath, [cli, ...args], {
        cwd: repository,
        env,
        encoding: "utf8",
      });

    expect(run(["version"])).toContain("agentic 0.1.0");
    run(["init"]);
    const taskFile = join(workDir, "task.json");
    writeFileSync(
      taskFile,
      JSON.stringify(
        {
          id: "P1",
          title: "Add the pack utility",
          milestone: "pack-smoke",
          status: "ready",
          priority: "P0",
          risk: "low",
          type: "implementation",
          objective:
            "Create src/pack/pack.cjs exporting packValue(), and test/pack/pack.test.cjs covering it.",
          acceptance_criteria: ["src/pack/pack.cjs exports packValue."],
          depends_on: [],
          provenance: { kind: "user_request", source: "manual" },
          scope: {
            allowed_paths: ["src/pack/**", "test/pack/**"],
            forbidden_paths: [],
          },
          resources: ["resource-pack"],
          workflow: "simple",
          routing: { complexity: "small", capabilities: ["javascript"] },
          verification: { required: ["unit"] },
          limits: { max_attempts: 3, max_review_cycles: 2 },
          approval: { required: false },
        },
        null,
        2,
      ),
    );
    run(["tasks", "add", taskFile]);
    const runOutput = run(["run", "P1"]);
    expect(runOutput).toContain("completed");
    const status = run(["status"]);
    expect(status).toContain("1 DONE");
    expect(runGit(repository, ["log", "--format=%s"])).toContain(
      "task P1: Add the pack utility",
    );
  });
});
