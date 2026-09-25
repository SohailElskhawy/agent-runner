import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env["AGENTIC_KILL_REPO_ROOT"];
if (root !== undefined && process.cwd() === root) {
  const marker = join(root, ".slow-verification-marker");
  if (!existsSync(marker)) {
    writeFileSync(marker, "1", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
}
process.exit(0);
