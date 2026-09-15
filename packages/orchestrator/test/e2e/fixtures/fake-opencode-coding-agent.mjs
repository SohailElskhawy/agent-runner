import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";

const journalPath = process.env.AGENTIC_FAKE_AGENT_JOURNAL ?? null;

async function journal(entry) {
  if (journalPath === null) {
    return;
  }
  await appendFile(journalPath, `${JSON.stringify(entry)}\n`, "utf8");
}

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

const cwd = process.cwd();
const gitMetadata = statSync(join(cwd, ".git"));
const insideWorktree = gitMetadata.isFile();

await journal({
  phase: "started",
  argv,
  cwd,
  insideWorktree,
  taskId: contextPack.task?.id ?? null,
});

const holdMs = Number(process.env.AGENTIC_FAKE_AGENT_HOLD_MS ?? "0");
if (holdMs > 0) {
  await new Promise((resolve) => {
    setTimeout(resolve, holdMs);
  });
}

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

await journal({ phase: "changed", changed });

process.stdout.write(
  JSON.stringify({
    argv,
    cwd,
    insideWorktree,
    taskId: contextPack.task?.id ?? null,
    objective: contextPack.task?.definition?.objective ?? null,
    agentsMarkdownPath: contextPack.agentsMarkdownPath ?? null,
    changed,
  }),
);
