import { readFile } from "node:fs/promises";

const delayMs = Number(process.env.FAKE_AGENT_DELAY_MS ?? "0");
if (delayMs > 0) {
  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

const args = process.argv.slice(2);
const version = process.env.FAKE_AGENT_VERSION ?? "1.0.0";
const major = Number(version.match(/(\d+)\.\d+/)?.[1] ?? "1");
const prompt = args.at(-1) ?? "";
const quoted = prompt.match(/"([^"]+)"/);
let contextContent = null;
if (quoted !== null) {
  try {
    contextContent = await readFile(quoted[1], "utf8");
  } catch {
    contextContent = null;
  }
}

if (args.includes("--version")) {
  process.stdout.write(`fake opencode ${version}\n`);
  process.exit(0);
}

if (major >= 2) {
  // Emulates the opencode 2.x CLI strictness observed live on 2.2.0.
  if (args.includes("--pure")) {
    process.stderr.write(`Unrecognized flag: --pure\n`);
    process.exit(1);
  }
  const agentIndex = args.indexOf("--agent");
  if (agentIndex !== -1 && !args.includes("--standalone")) {
    // 2.x `run` without --standalone attaches to the shared background server,
    // which never received our injected OPENCODE_CONFIG agent.
    process.stderr.write(`Agent not found: "${args[agentIndex + 1]}"\n`);
    process.exit(1);
  }
}

process.stdout.write(
  JSON.stringify({
    argv: args,
    cwd: process.cwd(),
    contextContent,
  }),
);
process.exit(Number(process.env.FAKE_AGENT_EXIT_CODE ?? "0"));
