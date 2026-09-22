#!/usr/bin/env node
// Creates the Agentic Dev Runner multi-task dogfood fixture repository and
// prints the exact commands to run the scenario with a real installed agent.
//
// Usage: node scripts/dogfood/multi-task-fixture.mjs [target-directory]

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

const target = resolve(process.argv[2] ?? mkdtempSync(join(process.cwd(), "agentic-dogfood-")));
const repositoryPath = join(target, "fixture repo");
const tasksDir = join(target, "tasks");

mkdirSync(repositoryPath, { recursive: true });
mkdirSync(tasksDir, { recursive: true });

writeFileSync(
  join(repositoryPath, "AGENTS.md"),
  [
    "# Dogfood rules",
    "",
    "- Implement exactly the utility each task describes.",
    "- Keep every change inside the task scope.",
    "- Add tests next to the implementation.",
    "",
  ].join("\n"),
);
writeFileSync(join(repositoryPath, "README.md"), "dogfood fixture\n");
writeFileSync(
  join(repositoryPath, "agentic.yaml"),
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

const task = (id, title, objective, dependsOn, allowedPaths, resources) =>
  JSON.stringify(
    {
      id,
      title,
      milestone: "dogfood-multi-task",
      status: "ready",
      priority: "P0",
      risk: "low",
      type: "implementation",
      objective,
      acceptance_criteria: [`The objective of ${id} is satisfied and covered by tests.`],
      depends_on: dependsOn,
      provenance: { kind: "user_request", source: "manual" },
      scope: { allowed_paths: allowedPaths, forbidden_paths: [] },
      resources,
      workflow: "simple",
      routing: { complexity: "small", capabilities: ["javascript"] },
      verification: { required: ["unit"] },
      limits: { max_attempts: 3, max_review_cycles: 2 },
      approval: { required: false },
    },
    null,
    2,
  ) + "\n";

writeFileSync(
  join(tasksDir, "task-A.json"),
  task(
    "A",
    "Add the alpha title utility",
    "Create src/alpha/alpha.cjs exporting toUpperTitle(value) that trims and uppercases a non-empty string and throws TypeError on non-string input, plus test/alpha/alpha.test.cjs covering it.",
    [],
    ["src/alpha/**", "test/alpha/**"],
    ["resource-alpha"],
  ),
);
writeFileSync(
  join(tasksDir, "task-B.json"),
  task(
    "B",
    "Add the beta slug utility",
    "Create src/beta/beta.cjs exporting toLowerSlug(value) that trims, lowercases, and dashes a non-empty string and throws TypeError on non-string input, plus test/beta/beta.test.cjs covering it.",
    [],
    ["src/beta/**", "test/beta/**"],
    ["resource-beta"],
  ),
);
writeFileSync(
  join(tasksDir, "task-C.json"),
  task(
    "C",
    "Add the gamma combined label utility",
    "Create src/gamma/gamma.cjs exporting combineLabel(value) that uses the alpha and beta utilities to produce \"<slug>: <TITLE>\", plus test/gamma/gamma.test.cjs covering it.",
    ["A", "B"],
    ["src/gamma/**", "test/gamma/**"],
    ["resource-gamma"],
  ),
);

const git = (args) => execFileSync("git", args, { cwd: repositoryPath, stdio: "pipe" });
git(["init"]);
git(["config", "user.email", "dogfood@example.com"]);
git(["config", "user.name", "Agentic Dogfood"]);
git(["add", "."]);
git(["commit", "-m", "initial commit"]);

console.log(`Fixture repository created at: ${repositoryPath}`);
console.log(
  [
    "",
    "Run the scenario with a real installed agent:",
    "",
    `  cd "${repositoryPath}"`,
    '  agentic init',
    `  agentic tasks add "${join(tasksDir, "task-A.json")}"`,
    `  agentic tasks add "${join(tasksDir, "task-B.json")}"`,
    `  agentic tasks add "${join(tasksDir, "task-C.json")}"`,
    "  agentic run --parallel 2",
    "  agentic status",
    "  agentic inspect A",
    "  agentic inspect B",
    "  agentic inspect C",
    "  git log --oneline",
    "",
    "A and B run concurrently in separate worktrees; C runs after both are",
    "DONE. Every task commit lands on the integration branch.",
    "",
  ].join("\n"),
);
