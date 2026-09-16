import type { AgentDescriptor } from "../runtime/agent-runtime.js";

export type AgentAvailability = {
  readonly id: string;
  readonly available: boolean;
  readonly version: string | null;
  readonly reason: string | null;
};

export type AgentProbeOutcome = {
  readonly available: boolean;
  readonly version: string | null;
  readonly reason: string | null;
};

export interface DiscoverableAgent {
  readonly descriptor: AgentDescriptor;
  probeAvailability(): Promise<AgentProbeOutcome>;
}
