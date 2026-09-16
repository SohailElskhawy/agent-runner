import type { CliIo } from "../io.js";
import type { AgentStatusEntry } from "../application/ports.js";

export function renderAgentsReport(
  io: CliIo,
  agents: readonly AgentStatusEntry[],
): void {
  if (agents.length === 0) {
    io.writeLine("agents: (none)");
    return;
  }
  const idWidth = Math.max(
    ...agents.map((agent) => agent.id.length),
    "ID".length,
  );
  io.writeLine(`${"ID".padEnd(idWidth)}  AVAILABLE`);
  for (const agent of agents) {
    io.writeLine(`${agent.id.padEnd(idWidth)}  ${agent.available ? "yes" : "no"}`);
    if (agent.available && agent.version !== null) {
      io.writeLine(`    version: ${agent.version}`);
    }
    if (!agent.available && agent.reason !== null) {
      io.writeLine(`    reason: ${agent.reason}`);
    }
  }
}
