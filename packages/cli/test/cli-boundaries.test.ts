import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const COMMAND_MODULE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
);
const COMMAND_FILES = [
  "io.ts",
  "parse-args.ts",
  "run-cli.ts",
  "commands/execute-commands.ts",
  "render/render-init.ts",
  "render/render-run.ts",
  "render/render-status.ts",
  "render/render-inspect.ts",
  "render/render-tasks-add.ts",
  "render/render-tasks-list.ts",
  "render/render-agents.ts",
];

const FORBIDDEN_SPECIFIERS = [
  "@agentic-dev-runner/git",
  "@agentic-dev-runner/persistence",
  "@agentic-dev-runner/platform",
  "@agentic-dev-runner/agents",
  "@agentic-dev-runner/orchestrator",
  "@agentic-dev-runner/verification",
  "node:sqlite",
  "node:child_process",
];

const ROUTING_SPECIFIERS = [
  "selectAgentProfile",
  "resolveRoutedAgent",
  "discoverAgents",
  "createAgentAdapterRegistry",
  "agentProfiles",
];

describe("CLI presentation boundary", () => {
  it("command modules contain no orchestration, git, sqlite, process, or provider logic", () => {
    for (const file of COMMAND_FILES) {
      const source = readFileSync(join(COMMAND_MODULE_DIR, file), "utf8");
      for (const specifier of FORBIDDEN_SPECIFIERS) {
        expect(
          source.includes(`from "${specifier}"`) ||
            source.includes(`import("${specifier}")`),
          `${file} must not reference "${specifier}"`,
        ).toBe(false);
      }
      expect(
        source.includes("createSingleTaskOrchestrator") ||
          source.includes("DatabaseSync") ||
          source.includes("spawn("),
        `${file} must not contain orchestration/SQLite/process logic`,
      ).toBe(false);
    }
  });

  it("command modules contain no agent routing logic", () => {
    for (const file of COMMAND_FILES) {
      const source = readFileSync(join(COMMAND_MODULE_DIR, file), "utf8");
      for (const marker of ROUTING_SPECIFIERS) {
        expect(
          source.includes(marker),
          `${file} must not reference "${marker}"`,
        ).toBe(false);
      }
    }
  });

  it("routing lives in application wiring rather than command modules", () => {
    const routingSource = readFileSync(
      join(COMMAND_MODULE_DIR, "application", "agents", "agent-routing.ts"),
      "utf8",
    );
    expect(routingSource).toContain("selectAgentProfile");
    const routedOrchestratorSource = readFileSync(
      join(COMMAND_MODULE_DIR, "application", "agents", "routed-task-orchestrator.ts"),
      "utf8",
    );
    expect(routedOrchestratorSource).toContain("resolveRoutedAgent");
    const appServicesSource = readFileSync(
      join(COMMAND_MODULE_DIR, "application", "app-services.ts"),
      "utf8",
    );
    expect(appServicesSource).toContain("createRoutedTaskOrchestrator");
  });

  it("wiring keeps infrastructure composition outside command modules", () => {
    const wiringSource = readFileSync(
      join(COMMAND_MODULE_DIR, "wiring.ts"),
      "utf8",
    );
    expect(wiringSource).toContain("createAppServices");
    const executeSource = readFileSync(
      join(COMMAND_MODULE_DIR, "commands", "execute-commands.ts"),
      "utf8",
    );
    expect(executeSource).not.toContain("@agentic-dev-runner/git");
    expect(executeSource).not.toContain("@agentic-dev-runner/orchestrator");
  });
});
