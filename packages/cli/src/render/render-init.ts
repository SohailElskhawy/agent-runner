import type { CliIo } from "../io.js";
import type { InitResult } from "../application/ports.js";

export function renderInitResult(io: CliIo, result: InitResult): void {
  io.writeLine("runner state initialized");
  io.writeLine(`  project: ${result.projectId}`);
  io.writeLine(`  root: ${result.projectRoot}`);
  io.writeLine(`  state: ${result.storePath}`);
}
