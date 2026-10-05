#!/usr/bin/env node
// Create a defined or nearly empty TODO app Git repository for launch dogfood.
// Usage: node scripts/dogfood/todo-app-fixture.mjs <defined|empty> [target]
//        node scripts/dogfood/todo-app-fixture.mjs --check

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectSpec = readFileSync(join(scriptDir, "todo-app-spec/PROJECT_SPEC.md"), "utf8");
const agentInstructions = readFileSync(join(scriptDir, "todo-app-spec/AGENTS.md"), "utf8");
const emptyAgentInstructions = `# TODO app implementation rules

- Follow the repository README and recorded project decisions.
- Use browser-native HTML, CSS, and JavaScript; do not add dependencies.
- Keep changes within the current task's objective and acceptance criteria.
- Add or update focused tests for behavior changes.
- Run the configured unit check before reporting completion.
`;

function createFixture(kind, target) {
  mkdirSync(target);
  const files = kind === "defined"
      ? {
        "docs/PROJECT_SPEC.md": projectSpec,
        "AGENTS.md": agentInstructions,
        "package.json": '{"type":"commonjs"}\n',
        "README.md": "# TODO app\n\nImplement the project described in docs/PROJECT_SPEC.md.\n",
        ".gitignore": ".serena/\n",
      }
    : {
        "AGENTS.md": emptyAgentInstructions,
        "package.json": '{"type":"commonjs"}\n',
        "README.md": "# TODO app\n\nGoal: build a small TODO website where I can add, complete, delete, and keep tasks after reload.\n",
        ".gitignore": ".serena/\n",
    };

  for (const [name, content] of Object.entries(files)) {
    const file = join(target, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  writeFileSync(
    join(target, "agentic.yaml"),
    [
      "verification:", "  checks:", "    unit:", "      command: node", "      args:", "        - --test",
      "agents:", "  profiles:",
      "    planner:", "      adapter: codex", "      capabilities:", "        - planning",
      "    economy:", "      adapter: codex", "      tier: economy", "      capabilities:",
      "        - html", "        - css", "        - javascript", "        - testing", "        - accessibility", "        - documentation", "        - browser-storage",
      "    standard:", "      adapter: codex", "      tier: standard", "      capabilities:",
      "        - html", "        - css", "        - javascript", "        - testing", "        - accessibility", "        - documentation", "        - browser-storage",
      "    strong:", "      adapter: codex", "      tier: strong", "      capabilities:",
      "        - html", "        - css", "        - javascript", "        - testing", "        - accessibility", "        - documentation", "        - browser-storage",
      "planning:", "  profile: planner", "",
    ].join("\n"),
  );

  const git = (args) => execFileSync("git", args, { cwd: target, stdio: "pipe" });
  git(["init"]);
  git(["config", "user.email", "dogfood@example.com"]);
  git(["config", "user.name", "Agentic Dogfood"]);
  git(["add", "."]);
  git(["commit", "-m", "initial TODO app fixture"]);
}

function checkFixtures() {
  const root = mkdtempSync(join(tmpdir(), "agentic-todo-fixture-check-"));
  try {
    for (const kind of ["defined", "empty"]) {
      const repo = join(root, kind);
      createFixture(kind, repo);
      assert.ok(execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: repo }).toString().trim());
      assert.match(readFileSync(join(repo, "agentic.yaml"), "utf8"), /--test/);
      assert.deepEqual(
        readdirSync(repo).filter((name) => name !== ".git").sort(),
        kind === "defined"
          ? [".gitignore", "AGENTS.md", "README.md", "agentic.yaml", "docs", "package.json"]
          : [".gitignore", "AGENTS.md", "README.md", "agentic.yaml", "package.json"],
      );
    }
    assert.match(readFileSync(join(root, "defined", "docs", "PROJECT_SPEC.md"), "utf8"), /Required behavior/);
    assert.match(readFileSync(join(root, "defined", "AGENTS.md"), "utf8"), /implementation rules/);
    assert.match(readFileSync(join(root, "empty", "README.md"), "utf8"), /Goal:/);
    for (const kind of ["defined", "empty"]) {
      assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: join(root, kind) }).toString(), "");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const [kind, targetArg] = process.argv.slice(2);
if (kind === "--check" && !targetArg) {
  checkFixtures();
  console.log("TODO fixture self-check passed");
} else if ((kind === "defined" || kind === "empty") && process.argv.slice(2).length <= 2) {
  const target = resolve(targetArg ?? join(process.cwd(), ".agentic-dogfood", `todo-${kind}`));
  mkdirSync(dirname(target), { recursive: true });
  createFixture(kind, target);
  console.log(`Created ${kind} TODO fixture: ${target}`);
} else {
  console.error("Usage: node scripts/dogfood/todo-app-fixture.mjs <defined|empty> [target]\n       node scripts/dogfood/todo-app-fixture.mjs --check");
  process.exitCode = 2;
}
