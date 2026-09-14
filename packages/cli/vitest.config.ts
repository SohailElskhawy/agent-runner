import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@agentic-dev-runner/agents": fileURLToPath(
        new URL("../agents/src/index.ts", import.meta.url),
      ),
      "@agentic-dev-runner/core": fileURLToPath(
        new URL("../core/src/index.ts", import.meta.url),
      ),
      "@agentic-dev-runner/git": fileURLToPath(
        new URL("../git/src/index.ts", import.meta.url),
      ),
      "@agentic-dev-runner/orchestrator": fileURLToPath(
        new URL("../orchestrator/src/index.ts", import.meta.url),
      ),
      "@agentic-dev-runner/persistence": fileURLToPath(
        new URL("../persistence/src/index.ts", import.meta.url),
      ),
      "@agentic-dev-runner/platform": fileURLToPath(
        new URL("../platform/src/index.ts", import.meta.url),
      ),
      "@agentic-dev-runner/verification": fileURLToPath(
        new URL("../verification/src/index.ts", import.meta.url),
      ),
    },
  },
});
