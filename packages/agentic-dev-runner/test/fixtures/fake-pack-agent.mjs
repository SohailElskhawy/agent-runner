import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const prompt = process.argv.at(-1) ?? "";
if (prompt === "--version") {
  process.stdout.write("fake opencode pack 1.0.0\n");
  process.exit(0);
}
const quoted = prompt.match(/Read the task context pack at "([^"]+)"/);
if (quoted === null) {
  console.error(`unexpected prompt: ${prompt}`);
  process.exit(2);
}
const contextPack = JSON.parse(await readFile(quoted[1], "utf8"));
if (contextPack.task?.id !== "P1") {
  console.error(`unexpected task: ${String(contextPack.task?.id)}`);
  process.exit(3);
}
const files = {
  "src/pack/pack.cjs": [
    "function packValue() {",
    '  return "packed";',
    "}",
    "",
    "module.exports = { packValue };",
    "",
  ].join("\n"),
  "test/pack/pack.test.cjs": [
    'const test = require("node:test");',
    'const assert = require("node:assert/strict");',
    'const { packValue } = require("../../src/pack/pack.cjs");',
    "",
    'test("packValue returns the packed marker", () => {',
    '  assert.equal(packValue(), "packed");',
    "});",
    "",
  ].join("\n"),
};
for (const [relativePath, content] of Object.entries(files)) {
  const target = join(process.cwd(), relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}
process.stdout.write("fake agent completed\n");
