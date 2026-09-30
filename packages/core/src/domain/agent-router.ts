/**
 * Deterministic rule-based agent routing.
 *
 * The router is pure application logic: it consumes an already-normalized
 * routing request — required task capabilities, candidate agent profiles, and
 * externally discovered adapter availability — and returns either the selected
 * profile or a structured no-route result with deterministic diagnostics.
 *
 * It never probes adapters, never executes processes, never branches on a
 * provider identity, and never decides the next task state; discovery supplies
 * availability externally and scheduling decides what to do with the result.
 *
 * Selection rules, applied in order:
 * 1. Only available (adapter present) and eligible (declares every required
 *    capability) candidates may be selected.
 * 2. A lower declared model/cost class is preferred only when the domain
 *    already carries such information. The current domain has no cost-class
 *    dimension — `AgentProfile.model` is an opaque identifier — so no
 *    cost-based preference is applied.
 * 3. The supplied candidate order is the deterministic tie-breaker: the first
 *    remaining candidate in the supplied order is selected.
 *
 * Rejection precedence per candidate: an unavailable adapter always rejects
 * first, because a capability match is meaningless when the adapter cannot
 * run. Diagnostics are provider-independent and derive only from the supplied
 * inputs, so identical inputs always produce identical results.
 */

import type { AgentProfile } from "./agent-profile.js";
import { evaluateAgentProfileEligibility } from "./agent-profile.js";
import { profileTier } from "./agent-profile.js";
import type { AgentTier } from "./agent-tier.js";

const TIER_RANK: Record<AgentTier, number> = { economy: 0, standard: 1, strong: 2 };

export type AgentRouteAvailability = {
  readonly id: string;
  readonly available: boolean;
};

export type AgentRouteCandidate = {
  readonly profile: AgentProfile;
  readonly availability: AgentRouteAvailability;
};

export type AgentRouteRequest = {
  readonly requiredCapabilities: readonly string[];
  readonly candidates: readonly AgentRouteCandidate[];
  readonly minimumTier?: AgentTier;
};

export type AgentRouteRejection =
  | {
      readonly reason: "adapter-unavailable";
      readonly profileId: string;
    }
  | {
      readonly reason: "missing-capabilities";
      readonly profileId: string;
      readonly missingCapabilities: readonly string[];
    }
  | {
      readonly reason: "below-minimum-tier";
      readonly profileId: string;
      readonly tier: AgentTier;
      readonly minimumTier: AgentTier;
    };

export type AgentRouteResult =
  | { readonly selected: true; readonly profile: AgentProfile }
  | {
      readonly selected: false;
      readonly rejections: readonly AgentRouteRejection[];
    };

export function selectAgentProfile(
  request: AgentRouteRequest,
): AgentRouteResult {
  const rejections: AgentRouteRejection[] = [];
  let selected: AgentProfile | undefined;
  let selectedTier = Number.POSITIVE_INFINITY;
  const minimumTier = request.minimumTier ?? "economy";

  for (const candidate of request.candidates) {
    if (!candidate.availability.available) {
      rejections.push({
        reason: "adapter-unavailable",
        profileId: candidate.profile.id,
      });
      continue;
    }
    const eligibility = evaluateAgentProfileEligibility(
      candidate.profile,
      request.requiredCapabilities,
    );
    if (!eligibility.eligible) {
      rejections.push({
        reason: "missing-capabilities",
        profileId: candidate.profile.id,
        missingCapabilities: eligibility.missingCapabilities,
      });
      continue;
    }
    const tier = profileTier(candidate.profile);
    if (TIER_RANK[tier] < TIER_RANK[minimumTier]) {
      rejections.push({
        reason: "below-minimum-tier",
        profileId: candidate.profile.id,
        tier,
        minimumTier,
      });
      continue;
    }
    if (TIER_RANK[tier] < selectedTier) {
      selected = candidate.profile;
      selectedTier = TIER_RANK[tier];
    }
  }

  if (selected !== undefined) return { selected: true, profile: selected };
  return { selected: false, rejections };
}
