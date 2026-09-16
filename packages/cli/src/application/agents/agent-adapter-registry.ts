import type { AgentRuntime } from "@agentic-dev-runner/agents";

export interface AgentAdapterRegistry {
  readonly adapterIds: readonly string[];
  resolveAdapter(adapterId: string): AgentRuntime | null;
}

export function createAgentAdapterRegistry(
  adapters: readonly AgentRuntime[],
): AgentAdapterRegistry {
  const byId = new Map<string, AgentRuntime>();
  for (const adapter of adapters) {
    byId.set(adapter.descriptor.id, adapter);
  }
  return {
    adapterIds: [...byId.keys()],
    resolveAdapter(adapterId: string): AgentRuntime | null {
      return byId.get(adapterId) ?? null;
    },
  };
}
