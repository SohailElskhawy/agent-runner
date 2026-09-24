import type { CliIo } from "../io.js";
import type { RunResult } from "../application/ports.js";

export function renderRunResult(io: CliIo, result: RunResult): void {
  switch (result.kind) {
    case "completed":
      io.writeLine(result.message);
      break;
    case "failed":
    case "cancelled":
    case "blocked":
    case "rejected":
      io.writeError(result.message);
      break;
  }
}
