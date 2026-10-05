import { readFile } from "node:fs/promises";

const delayMs = Number(process.env.FAKE_AGENT_DELAY_MS ?? "0");
if (delayMs > 0) {
  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

const args = process.argv.slice(2);
const prompt = args.at(-1) ?? "";
const quoted = prompt.match(/"([^"]+)"/);
let contextContent = null;
let contextPath = null;
if (quoted !== null) {
  contextPath = quoted[1];
  try {
    contextContent = await readFile(quoted[1], "utf8");
  } catch {
    contextContent = null;
  }
}

process.stdout.write(
  JSON.stringify({
    argv: args,
    cwd: process.cwd(),
    contextPath,
    contextContent,
  }),
);
process.exit(Number(process.env.FAKE_AGENT_EXIT_CODE ?? "0"));
