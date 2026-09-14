import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@agentic-dev-runner/platform": fileURLToPath(
        new URL("../platform/src/index.ts", import.meta.url),
      ),
    },
  },
});
