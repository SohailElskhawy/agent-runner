import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const prompt = process.argv.at(-1) ?? "";
if (process.argv.includes("--version") || prompt === "--version") {
  process.stdout.write("fake opencode 1.0.0\n");
  process.exit(0);
}
const quoted = prompt.match(/Read the task context pack at "([^"]+)"/);
if (!quoted) {
  process.exit(0);
}
const contextPack = JSON.parse(await readFile(quoted[1], "utf8"));
const taskId = contextPack.task.id;
const repoRoot = process.env["AGENTIC_KILL_REPO_ROOT"];
const repoMarker = repoRoot !== undefined ? join(repoRoot, `.kill-marker-${taskId}`) : undefined;
const marker = join(process.cwd(), `.kill-marker-${taskId}`);

const writeFiles = async () => {
  const files = {
    [`src/kill/${taskId}.cjs`]: `module.exports = { value: "${taskId}" };\n`,
    [`test/kill/${taskId}.test.cjs`]: [
      'const test = require("node:test");',
      'const assert = require("node:assert/strict");',
      `const { value } = require("../../src/kill/${taskId}.cjs");`,
      `test("value", () => { assert.equal(value, "${taskId}"); });`,
      "",
    ].join("\n"),
  };
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(process.cwd(), relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
};

const alreadyMarked =
  taskId !== "K1" ||
  existsSync(marker) ||
  (repoMarker !== undefined && existsSync(repoMarker));

if (alreadyMarked) {
  await writeFiles();
  process.exit(0);
}

await writeFile(marker, "1", "utf8");
if (repoMarker !== undefined) {
  try {
    await writeFile(repoMarker, "1", "utf8");
  } catch {
    // repo root might not be writable
  }
}
await new Promise((resolve) => setTimeout(resolve, 60_000));
await writeFiles();
process.exit(0);
