import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const resolve = (relative) => fileURLToPath(new URL(relative, import.meta.url));

const PACKAGE_ALIASES = {
  "@agentic-dev-runner/agents": resolve("../../agents/src/index.ts"),
  "@agentic-dev-runner/config": resolve("../../config/src/index.ts"),
  "@agentic-dev-runner/context": resolve("../../context/src/index.ts"),
  "@agentic-dev-runner/core": resolve("../../core/src/index.ts"),
  "@agentic-dev-runner/git": resolve("../../git/src/index.ts"),
  "@agentic-dev-runner/orchestrator": resolve("../../orchestrator/src/index.ts"),
  "@agentic-dev-runner/persistence": resolve("../../persistence/src/index.ts"),
  "@agentic-dev-runner/platform": resolve("../../platform/src/index.ts"),
  "@agentic-dev-runner/verification": resolve("../../verification/src/index.ts"),
};

const stripEntryHashbang = {
  name: "strip-entry-hashbang",
  setup(build) {
    build.onLoad({ filter: /[\\/]cli[\\/]src[\\/]main\.ts$/ }, async (args) => ({
      contents: (await readFile(args.path, "utf8")).replace(/^#![^\n]*\r?\n/, ""),
      loader: "ts",
    }));
  },
};

await build({
  entryPoints: [resolve("../../cli/src/main.ts")],
  outfile: resolve("../bundle/main.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  alias: PACKAGE_ALIASES,
  plugins: [stripEntryHashbang],
  banner: {
    js: `#!/usr/bin/env node
import { createRequire as __createRequire } from "node:module";
const require = __createRequire(import.meta.url);`,
  },
  legalComments: "none",
  sourcemap: false,
  logLevel: "info",
});
