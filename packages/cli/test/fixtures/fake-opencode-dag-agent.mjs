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

const MODULES = {
  A: {
    slug: "alpha",
    functionName: "toUpperTitle",
    files: {
      "src/alpha/alpha.cjs": [
        "function toUpperTitle(value) {",
        '  if (typeof value !== "string") {',
        '    throw new TypeError("value must be a string");',
        "  }",
        "  const trimmed = value.trim();",
        '  if (trimmed.length === 0) {',
        '    throw new RangeError("value must not be empty");',
        "  }",
        "  return trimmed.toUpperCase();",
        "}",
        "",
        "module.exports = { toUpperTitle };",
        "",
      ].join("\n"),
      "test/alpha/alpha.test.cjs": [
        'const test = require("node:test");',
        'const assert = require("node:assert/strict");',
        'const { toUpperTitle } = require("../../src/alpha/alpha.cjs");',
        "",
        'test("toUpperTitle normalizes titles", () => {',
        '  assert.equal(toUpperTitle("  hello "), "HELLO");',
        "  assert.throws(() => toUpperTitle(42), TypeError);",
        "});",
        "",
      ].join("\n"),
    },
  },
  B: {
    slug: "beta",
    functionName: "toLowerSlug",
    files: {
      "src/beta/beta.cjs": [
        "function toLowerSlug(value) {",
        '  if (typeof value !== "string") {',
        '    throw new TypeError("value must be a string");',
        "  }",
        '  const trimmed = value.trim().toLowerCase();',
        '  if (trimmed.length === 0) {',
        '    throw new RangeError("value must not be empty");',
        "  }",
        '  return trimmed.replaceAll(" ", "-");',
        "}",
        "",
        "module.exports = { toLowerSlug };",
        "",
      ].join("\n"),
      "test/beta/beta.test.cjs": [
        'const test = require("node:test");',
        'const assert = require("node:assert/strict");',
        'const { toLowerSlug } = require("../../src/beta/beta.cjs");',
        "",
        'test("toLowerSlug builds slugs", () => {',
        '  assert.equal(toLowerSlug("Hello World"), "hello-world");',
        "  assert.throws(() => toLowerSlug(42), TypeError);",
        "});",
        "",
      ].join("\n"),
    },
  },
  C: {
    slug: "gamma",
    functionName: "combineLabel",
    files: {
      "src/gamma/gamma.cjs": [
        'const { toUpperTitle } = require("../../src/alpha/alpha.cjs");',
        'const { toLowerSlug } = require("../../src/beta/beta.cjs");',
        "",
        "function combineLabel(value) {",
        '  if (typeof value !== "string") {',
        '    throw new TypeError("value must be a string");',
        "  }",
        "  const title = toUpperTitle(value);",
        "  const slug = toLowerSlug(value);",
        "  return `${slug}: ${title}`;",
        "}",
        "",
        "module.exports = { combineLabel };",
        "",
      ].join("\n"),
      "test/gamma/gamma.test.cjs": [
        'const test = require("node:test");',
        'const assert = require("node:assert/strict");',
        'const { combineLabel } = require("../../src/gamma/gamma.cjs");',
        "",
        'test("combineLabel uses both dependency modules", () => {',
        '  assert.equal(combineLabel("Hello"), "hello: HELLO");',
        "  assert.throws(() => combineLabel(42), TypeError);",
        "});",
        "",
      ].join("\n"),
    },
  },
};

const moduleForTask = MODULES[taskId];
if (moduleForTask === undefined) {
  console.error(`no fixture behavior for task "${taskId}"`);
  process.exit(5);
}

const cwd = process.cwd();
const changed = Object.keys(moduleForTask.files);
for (const relativePath of changed) {
  const target = join(cwd, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, moduleForTask.files[relativePath], "utf8");
}

process.stdout.write(
  JSON.stringify({
    argv,
    cwd,
    taskId,
    changed,
  }),
);
