import type { ProcessResult } from "@agentic-dev-runner/platform";
import type { AgentProbeOutcome } from "./agent-availability.js";

export const AGENT_PROBE_TIMEOUT_MS = 10_000;

export function normalizeProbeResult(
  result: ProcessResult,
  agentId: string,
): AgentProbeOutcome {
  const outcome = result.outcome;
  switch (outcome.kind) {
    case "completed":
      if (outcome.code === 0) {
        return {
          available: true,
          version: extractVersionLine(result.stdout) ?? extractVersionLine(result.stderr),
          reason: null,
        };
      }
      return {
        available: false,
        version: null,
        reason: `${agentId} version probe exited with code ${outcome.code}`,
      };
    case "terminated":
      return {
        available: false,
        version: null,
        reason: `${agentId} version probe was terminated by signal ${outcome.signal}`,
      };
    case "timeout":
      return {
        available: false,
        version: null,
        reason: `${agentId} version probe timed out`,
      };
    case "cancelled":
      return {
        available: false,
        version: null,
        reason: `${agentId} version probe was cancelled`,
      };
    case "spawn-error":
      return {
        available: false,
        version: null,
        reason: `${agentId} could not be started (${outcome.code}): ${outcome.message}`,
      };
  }
}

export function describeProbeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extractVersionLine(text: string): string | null {
  const line = text
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line ?? null;
}
