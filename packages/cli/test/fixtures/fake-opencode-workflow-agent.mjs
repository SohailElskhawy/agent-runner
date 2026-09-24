import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const prompt = process.argv.at(-1) ?? "";
const quoted = prompt.match(/Read the task context pack at "([^"]+)"/);
if (quoted === null) {
  console.error(`unexpected prompt: ${prompt}`);
  process.exit(2);
}
const contextPack = JSON.parse(await readFile(quoted[1], "utf8"));
const taskId = contextPack.task?.id;

if (prompt.includes("STAGE PLAN —")) {
  process.stdout.write("1. Create the workflow utility module and its test.\n");
  process.exit(0);
}
if (prompt.includes("STAGE PLAN_REVIEW —") || prompt.includes("STAGE CODE_REVIEW —")) {
  process.stdout.write(JSON.stringify({ decision: "APPROVED" }));
  process.exit(0);
}
if (prompt.includes("STAGE IMPLEMENT —")) {
  const files = {
    [`src/workflow/${taskId}.cjs`]: [
      "function describe() {",
      `  return "${taskId}";`,
      "}",
      "",
      "module.exports = { describe };",
      "",
    ].join("\n"),
    [`test/workflow/${taskId}.test.cjs`]: [
      'const test = require("node:test");',
      'const assert = require("node:assert/strict");',
      `const { describe } = require("../../src/workflow/${taskId}.cjs");`,
      "",
      `test("describe returns the task id", () => {`,
      `  assert.equal(describe(), "${taskId}");`,
      "});",
      "",
    ].join("\n"),
  };
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(process.cwd(), relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  process.exit(0);
}
console.error("unexpected stage instruction");
process.exit(9);
