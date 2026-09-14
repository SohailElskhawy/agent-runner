import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@agentic-dev-runner/core": fileURLToPath(
        new URL("./src/index.ts", import.meta.url),
      ),
    },
  },
});
