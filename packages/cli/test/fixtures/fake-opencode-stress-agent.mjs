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

const taskId = contextPack.task?.id;
if (typeof taskId !== "string") {
  console.error("context pack has no task id");
  process.exit(4);
}

const lower = taskId.toLowerCase();
const allowedPaths = Array.isArray(contextPack.task?.scope?.allowedPaths)
  ? contextPack.task.scope.allowedPaths
  : [];
const isSharedArea =
  taskId === "S9" ||
  taskId === "S10" ||
  allowedPaths.some((p) => typeof p === "string" && p.includes("shared-area"));

const cwd = process.cwd();
const files = isSharedArea
  ? {
      [`src/shared-area/${lower}.cjs`]: [
        `function ${lower}Util(value) {`,
        `  if (typeof value !== "string") {`,
        `    throw new TypeError("value must be a string");`,
        `  }`,
        `  return "${lower}:" + value;`,
        `}`,
        "",
        `module.exports = { ${lower}Util };`,
        "",
      ].join("\n"),
      [`test/shared-area/${lower}.test.cjs`]: [
        'const test = require("node:test");',
        'const assert = require("node:assert/strict");',
        `const { ${lower}Util } = require("../../src/shared-area/${lower}.cjs");`,
        "",
        `test("${lower} utility works", () => {`,
        `  assert.equal(${lower}Util("hello"), "${lower}:hello");`,
        `  assert.throws(() => ${lower}Util(123), TypeError);`,
        `});`,
        "",
      ].join("\n"),
    }
  : {
      [`src/${lower}/${lower}.cjs`]: [
        `function ${lower}Util(value) {`,
        `  if (typeof value !== "string") {`,
        `    throw new TypeError("value must be a string");`,
        `  }`,
        `  return "${lower}:" + value;`,
        `}`,
        "",
        `module.exports = { ${lower}Util };`,
        "",
      ].join("\n"),
      [`test/${lower}/${lower}.test.cjs`]: [
        'const test = require("node:test");',
        'const assert = require("node:assert/strict");',
        `const { ${lower}Util } = require("../../src/${lower}/${lower}.cjs");`,
        "",
        `test("${lower} utility works", () => {`,
        `  assert.equal(${lower}Util("hello"), "${lower}:hello");`,
        `  assert.throws(() => ${lower}Util(123), TypeError);`,
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
