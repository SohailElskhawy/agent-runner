import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);
const prompt = argv.at(-1) ?? "";
const quoted = prompt.match(/Read the task context pack at "([^"]+)"/);
if (quoted === null) {
  console.error(`unexpected prompt: ${prompt}`);
  process.exit(2);
}

let contextPack;
try {
  contextPack = JSON.parse(await readFile(quoted[1], "utf8"));
} catch (error) {
  console.error(`failed to read the context pack: ${String(error)}`);
  process.exit(3);
}

// Workflow stages invoke the same agent with an explicit stage instruction;
// the legacy single-task invocation carries none. Review stages must not
// mutate the worktree and the PLAN stage must produce plan text only.
if (
  prompt.includes("STAGE PLAN_REVIEW —") ||
  prompt.includes("STAGE CODE_REVIEW —")
) {
  process.stdout.write(JSON.stringify({ decision: "APPROVED" }));
  process.exit(0);
}
if (prompt.includes("STAGE PLAN —")) {
  process.stdout.write(
    "1. Create src/math/clamp.cjs with input validation.\n2. Add test/math/clamp.test.cjs covering the range behavior.\n",
  );
  process.exit(0);
}

const cwd = process.cwd();
const fixtureFiles = {
  "src/math/clamp.cjs": `function clamp(value, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("value must be a finite number");
  }
  if (typeof min !== "number" || !Number.isFinite(min)) {
    throw new TypeError("min must be a finite number");
  }
  if (typeof max !== "number" || !Number.isFinite(max)) {
    throw new TypeError("max must be a finite number");
  }
  return Math.min(Math.max(value, min), max);
}

module.exports = { clamp };
`,
  "test/math/clamp.test.cjs": `const test = require("node:test");
const assert = require("node:assert/strict");
const { clamp } = require("../../src/math/clamp.cjs");

test("clamp keeps values inside the inclusive range", () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
});

test("clamp rejects non-number input", () => {
  assert.throws(() => clamp("5", 0, 10), TypeError);
});
`,
};

const changed = Object.keys(fixtureFiles);
for (const relativePath of changed) {
  const target = join(cwd, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, fixtureFiles[relativePath], "utf8");
}

process.stdout.write(
  JSON.stringify({
    argv,
    cwd,
    taskId: contextPack.task?.id ?? null,
    changed,
  }),
);
