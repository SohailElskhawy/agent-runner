#!/usr/bin/env node
// Creates the Agentic Dev Runner 20-task roadmap dogfood fixture repository
// (V0.1 release criterion 1) and prints the exact commands to run the scenario
// with a real installed agent.
//
// Usage: node scripts/dogfood/roadmap-20-fixture.mjs [target-directory]

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const target = resolve(
  process.argv[2] ?? mkdtempSync(join(tmpdir(), "agentic-dogfood-roadmap-20-")),
);
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
writeFileSync(join(repositoryPath, "README.md"), "roadmap 20-task dogfood fixture\n");
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

const DEPENDENCIES = {
  T07: ["T01", "T02"],
  T08: ["T03"],
  T09: ["T04", "T05"],
  T10: ["T06"],
  T11: ["T02", "T06"],
  T12: ["T01", "T05"],
  T13: ["T07", "T08"],
  T14: ["T09", "T10"],
  T15: ["T11"],
  T16: ["T12"],
  T17: ["T07", "T11"],
  T18: ["T13", "T14"],
  T19: ["T15", "T16"],
  T20: ["T17"],
};

const SHARED_TASK_IDS = new Set(["T01", "T02", "T07", "T11"]);

const task = (id, slug, fnName, dependsOn, allowedPaths, resources) =>
  JSON.stringify(
    {
      id,
      title: `Add the ${fnName} utility`,
      milestone: "roadmap-v01",
      status: "ready",
      priority: "P0",
      risk: "low",
      type: "implementation",
      objective: `Create src/${slug}/${slug}.cjs exporting ${fnName}(value) that validates value is a string and returns a formatted result, plus test/${slug}/${slug}.test.cjs covering it.`,
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

const taskIds = Array.from({ length: 20 }, (_, i) => {
  const num = String(i + 1).padStart(2, "0");
  return `T${num}`;
});

for (const id of taskIds) {
  const slug = id.toLowerCase();
  const fnName = `format${id}`;
  const dependsOn = DEPENDENCIES[id] ?? [];
  const allowedPaths = [`src/${slug}/**`, `test/${slug}/**`];
  const resources = SHARED_TASK_IDS.has(id)
    ? ["resource-roadmap-shared"]
    : [`resource-${slug}`];

  writeFileSync(
    join(tasksDir, `task-${id}.json`),
    task(id, slug, fnName, dependsOn, allowedPaths, resources),
  );
}

const git = (args) => execFileSync("git", args, { cwd: repositoryPath, stdio: "pipe" });
git(["init"]);
git(["config", "user.email", "dogfood@example.com"]);
git(["config", "user.name", "Agentic Dogfood"]);
git(["config", "core.autocrlf", "false"]);
git(["add", "."]);
git(["commit", "-m", "initial commit"]);

console.log(`Fixture repository created at: ${repositoryPath}`);
console.log(
  [
    "",
    "Run the scenario with a real installed agent:",
    "",
    `  cd "${repositoryPath}"`,
    "  agentic init",
    ...taskIds.map((id) => `  agentic tasks add "${join(tasksDir, `task-${id}.json`)}"`),
    "  agentic run --parallel 4",
    "  agentic status",
    "  agentic inspect T20",
    "  git log --oneline",
    "",
    "Tasks run according to the 20-task roadmap DAG with up to 4 parallel workers.",
    "T01, T02, T07, and T11 run with disjoint execution spans via their shared resource lock.",
    "Every task commit lands on the integration branch after verification passes.",
    "",
  ].join("\n"),
);
