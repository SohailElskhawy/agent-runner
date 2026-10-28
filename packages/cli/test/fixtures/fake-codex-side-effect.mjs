import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [mode, ...args] = process.argv.slice(2);
if (!["allowed", "unexpected"].includes(mode) || args[0] !== "exec" || args[1] !== "--sandbox" || args[2] !== "workspace-write") {
  throw new Error("unexpected fake Codex invocation");
}
const contextPath = args.at(-1)?.match(/Read the task context pack at "([^"]+)"/)?.[1];
if (!contextPath || !(await readFile(contextPath, "utf8"))) throw new Error("missing context pack");
await mkdir(join(process.cwd(), "src"), { recursive: true });
await writeFile(join(process.cwd(), "src", "report.mjs"), "export const report = 'fixture';\n");
if (mode === "unexpected") {
  await mkdir(join(process.cwd(), ".serena"), { recursive: true });
  await writeFile(join(process.cwd(), ".serena", "project.yml"), "fixture: retained\n");
}
process.stdout.write(JSON.stringify({ cwd: process.cwd(), args }));
