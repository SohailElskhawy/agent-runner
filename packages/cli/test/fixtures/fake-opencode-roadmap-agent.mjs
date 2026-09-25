import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write("fake opencode roadmap 1.0.0\n");
  process.exit(0);
}

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

const taskId = contextPack.task?.id;
if (typeof taskId !== "string") {
  console.error("context pack has no task id");
  process.exit(4);
}

const lower = taskId.toLowerCase();
await sleep(50);

const cwd = process.cwd();
const files = {
  [`src/${lower}/${lower}.cjs`]: [
    "function value() {",
    `  return "${taskId}";`,
    "}",
    "",
    "module.exports = { value };",
    "",
  ].join("\n"),
  [`test/${lower}/${lower}.test.cjs`]: [
    'const test = require("node:test");',
    'const assert = require("node:assert/strict");',
    `const { value } = require("../../src/${lower}/${lower}.cjs");`,
    "",
    `test("${lower} value works", () => {`,
    `  assert.equal(value(), "${taskId}");`,
    `});`,
    "",
  ].join("\n"),
};

const changed = Object.keys(files);
for (const relativePath of changed) {
  const target = join(cwd, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, files[relativePath], "utf8");
}

process.stdout.write(
  JSON.stringify({
    argv,
    cwd,
    taskId,
    changed,
  }),
);
