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

if (prompt.includes("STAGE PLANNING —")) {
  const planningDocument = contextPack.documents?.find((document) => document.path === "PLANNING_INPUT.json");
  if (typeof planningDocument?.content !== "string") {
    console.error("planning context pack has no PlanningInput document");
    process.exit(6);
  }
  const planningInput = JSON.parse(planningDocument.content);
  const answered = planningInput.answeredQuestionIds?.includes("storage") === true;
  process.stdout.write(JSON.stringify(answered
    ? {
        version: 1,
        kind: "READY_FOR_PLANNING",
        milestones: [{ id: "M1", title: "TODO basics", completionCriteria: ["Tasks can be added and completed"] }],
        tasks: [
          { id: "T001", title: "Add TODO items", milestone: "M1", provenanceSource: "M1", risk: "low", type: "implementation", objective: "Add validated TODO items to an in-memory list.", acceptanceCriteria: ["addTodo appends an incomplete task"], dependsOn: [], allowedPaths: ["src/**", "test/**"], resources: [], routing: { complexity: "small", capabilities: ["javascript"] }, verification: ["unit"] },
          { id: "T002", title: "Complete TODO items", milestone: "M1", provenanceSource: "M1", risk: "low", type: "implementation", objective: "Add completion for an existing TODO item.", acceptanceCriteria: ["completeTodo marks the selected task complete"], dependsOn: ["T001"], allowedPaths: ["src/**", "test/**"], resources: [], routing: { complexity: "small", capabilities: ["javascript"] }, verification: ["unit"] },
        ],
      }
    : {
        version: 1,
        kind: "NEEDS_DISCOVERY",
        questions: [{ id: "storage", prompt: "Where should TODO items persist?", reason: "Persistence changes the implementation and data lifecycle.", importance: "important", choices: ["In-memory for this demo", "SQLite"] }],
      }));
  process.exit(0);
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
  F2: {
    slug: "foxtrot",
    functionName: "toFoxtrotLabel",
    files: {
      "src/foxtrot/foxtrot.cjs": [
        "function toFoxtrotLabel(value) {",
        '  if (typeof value !== "string") {',
        '    throw new TypeError("value must be a string");',
        "  }",
        "  const trimmed = value.trim();",
        '  if (trimmed.length === 0) {',
        '    throw new RangeError("value must not be empty");',
        "  }",
        '  return `foxtrot: ${trimmed}`;',
        "}",
        "",
        "module.exports = { toFoxtrotLabel };",
        "",
      ].join("\n"),
      "test/foxtrot/foxtrot.test.cjs": [
        'const test = require("node:test");',
        'const assert = require("node:assert/strict");',
        'const { toFoxtrotLabel } = require("../../src/foxtrot/foxtrot.cjs");',
        "",
        'test("toFoxtrotLabel labels the trimmed value", () => {',
        '  assert.equal(toFoxtrotLabel("  hello "), "foxtrot: hello");',
        "  assert.throws(() => toFoxtrotLabel(42), TypeError);",
        '  assert.throws(() => toFoxtrotLabel("   "), RangeError);',
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
  T001: {
    files: {
      "src/todo.cjs": [
        "function addTodo(todos, title) {",
        '  if (!Array.isArray(todos)) throw new TypeError("todos must be an array");',
        '  if (typeof title !== "string" || title.trim().length === 0) throw new TypeError("title must be non-empty");',
        '  return [...todos, { title: title.trim(), completed: false }];',
        "}", "", "module.exports = { addTodo };", "",
      ].join("\n"),
      "test/todo.test.cjs": [
        'const test = require("node:test");', 'const assert = require("node:assert/strict");',
        'const { addTodo } = require("../src/todo.cjs");', "",
        'test("addTodo appends a trimmed incomplete task", () => {',
        '  assert.deepEqual(addTodo([], "  buy milk "), [{ title: "buy milk", completed: false }]);',
        '  assert.throws(() => addTodo([], "  "), TypeError);', "});", "",
      ].join("\n"),
    },
  },
  T002: {
    files: {
      "src/todo.cjs": [
        "function addTodo(todos, title) {",
        '  if (!Array.isArray(todos)) throw new TypeError("todos must be an array");',
        '  if (typeof title !== "string" || title.trim().length === 0) throw new TypeError("title must be non-empty");',
        '  return [...todos, { title: title.trim(), completed: false }];',
        "}", "", "function completeTodo(todos, index) {",
        '  if (!Array.isArray(todos)) throw new TypeError("todos must be an array");',
        '  if (!Number.isInteger(index) || index < 0 || index >= todos.length) throw new RangeError("index is out of range");',
        '  return todos.map((todo, current) => current === index ? { ...todo, completed: true } : todo);',
        "}", "", "module.exports = { addTodo, completeTodo };", "",
      ].join("\n"),
      "test/todo.test.cjs": [
        'const test = require("node:test");', 'const assert = require("node:assert/strict");',
        'const { addTodo, completeTodo } = require("../src/todo.cjs");', "",
        'test("addTodo appends a trimmed incomplete task", () => {',
        '  assert.deepEqual(addTodo([], "  buy milk "), [{ title: "buy milk", completed: false }]);',
        '  assert.throws(() => addTodo([], "  "), TypeError);', "});", "",
        'test("completeTodo marks the selected task complete", () => {',
        '  const todos = addTodo([], "buy milk");',
        '  assert.deepEqual(completeTodo(todos, 0), [{ title: "buy milk", completed: true }]);',
        '  assert.throws(() => completeTodo(todos, 2), RangeError);', "});", "",
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
