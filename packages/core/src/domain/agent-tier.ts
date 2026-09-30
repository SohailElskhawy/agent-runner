export const AGENT_TIERS = ["economy", "standard", "strong"] as const;

export type AgentTier = (typeof AGENT_TIERS)[number];

export function isAgentTier(value: unknown): value is AgentTier {
  return AGENT_TIERS.some((tier) => tier === value);
}
