import type { AgentAvailability, DiscoverableAgent } from "./agent-availability.js";
import { describeProbeFailure } from "./agent-probe.js";

export interface AgentRegistry {
  readonly agentIds: readonly string[];
  discoverAgents(): Promise<readonly AgentAvailability[]>;
}

export function createAgentRegistry(
  agents: readonly DiscoverableAgent[],
): AgentRegistry {
  return new StaticAgentRegistry(agents);
}

class StaticAgentRegistry implements AgentRegistry {
  private readonly agents: readonly DiscoverableAgent[];

  constructor(agents: readonly DiscoverableAgent[]) {
    this.agents = [...agents];
  }

  get agentIds(): readonly string[] {
    return this.agents.map((agent) => agent.descriptor.id);
  }

  async discoverAgents(): Promise<readonly AgentAvailability[]> {
    return Promise.all(this.agents.map((agent) => this.probeAgent(agent)));
  }

  private async probeAgent(
    agent: DiscoverableAgent,
  ): Promise<AgentAvailability> {
    try {
      const outcome = await agent.probeAvailability();
      return {
        id: agent.descriptor.id,
        available: outcome.available,
        version: outcome.version,
        reason: outcome.reason,
      };
    } catch (error) {
      return {
        id: agent.descriptor.id,
        available: false,
        version: null,
        reason: describeProbeFailure(error),
      };
    }
  }
}
