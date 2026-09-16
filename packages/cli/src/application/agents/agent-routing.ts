/**
 * Application wiring that joins configured agent profiles, discovered adapter
 * availability, and concrete adapter instances into a routing decision.
 *
 * This is the explicit boundary between the pure core router
 * (`selectAgentProfile`) and the runtime: discovery only reports availability,
 * this module enforces the identity invariant by joining each profile to the
 * availability record that carries the same adapter id (never by array
 * position), resolves the selected profile's adapter, and wraps it so the
 * selected profile's optional model is carried on the invocation descriptor.
 *
 * This module never falls back to a hard-coded adapter: when no profile can
 * route the task it returns a structured no-route result with deterministic
 * diagnostics derived only from the supplied inputs.
 */

import type {
  AgentProfile,
  AgentRouteRejection,
} from "@agentic-dev-runner/core";
import { selectAgentProfile } from "@agentic-dev-runner/core";
import type {
  AgentAvailability,
  AgentRegistry,
  AgentRuntime,
} from "@agentic-dev-runner/agents";
import type { AgentAdapterRegistry } from "./agent-adapter-registry.js";

export type RoutedAgentSelection =
  | {
      readonly routed: true;
      readonly runtime: AgentRuntime;
      readonly profile: AgentProfile;
    }
  | {
      readonly routed: false;
      readonly reason: string;
    };

export type ResolveRoutedAgentInput = {
  readonly requiredCapabilities: readonly string[];
  readonly agentProfiles: readonly AgentProfile[];
  readonly agents: AgentRegistry;
  readonly adapters: AgentAdapterRegistry;
};

export async function resolveRoutedAgent(
  input: ResolveRoutedAgentInput,
): Promise<RoutedAgentSelection> {
  if (input.agentProfiles.length === 0) {
    return {
      routed: false,
      reason:
        "no agent profiles are configured in the project configuration (agents.profiles)",
    };
  }

  const availability = await input.agents.discoverAgents();
  const availabilityById = joinAvailabilityById(availability);
  const route = selectAgentProfile({
    requiredCapabilities: input.requiredCapabilities,
    candidates: input.agentProfiles.map((profile) => ({
      profile,
      availability: availabilityForProfile(profile, availabilityById),
    })),
  });

  if (!route.selected) {
    return {
      routed: false,
      reason: describeNoRoute(input.agentProfiles, availabilityById, route.rejections),
    };
  }

  const adapter = input.adapters.resolveAdapter(route.profile.adapterId);
  if (adapter === null) {
    return {
      routed: false,
      reason: `no adapter is registered for the selected profile "${route.profile.id}" (adapter "${route.profile.adapterId}")`,
    };
  }

  return {
    routed: true,
    runtime: selectedAgentRuntime(adapter, route.profile.model),
    profile: route.profile,
  };
}

function joinAvailabilityById(
  availability: readonly AgentAvailability[],
): Map<string, AgentAvailability> {
  return new Map(availability.map((record) => [record.id, record]));
}

function availabilityForProfile(
  profile: AgentProfile,
  availabilityById: ReadonlyMap<string, AgentAvailability>,
): { readonly id: string; readonly available: boolean } {
  const record = availabilityById.get(profile.adapterId);
  return {
    id: profile.adapterId,
    available: record?.available === true,
  };
}

function describeNoRoute(
  profiles: readonly AgentProfile[],
  availabilityById: ReadonlyMap<string, AgentAvailability>,
  rejections: readonly AgentRouteRejection[],
): string {
  const adaptersByProfileId = new Map(
    profiles.map((profile) => [profile.id, profile.adapterId]),
  );
  const described = rejections.map((rejection) => {
    const adapterId = adaptersByProfileId.get(rejection.profileId) ?? "unknown";
    if (rejection.reason === "adapter-unavailable") {
      return availabilityById.has(adapterId)
        ? `profile "${rejection.profileId}" cannot run because its adapter "${adapterId}" is unavailable`
        : `profile "${rejection.profileId}" references unknown adapter "${adapterId}" with no discovery result`;
    }
    return `profile "${rejection.profileId}" is missing required capabilities: ${rejection.missingCapabilities.join(", ")}`;
  });
  return `no eligible agent profile: ${described.join("; ")}`;
}

export function selectedAgentRuntime(
  adapter: AgentRuntime,
  model: string | undefined,
): AgentRuntime {
  return {
    descriptor: {
      id: adapter.descriptor.id,
      ...(model === undefined ? {} : { model }),
    },
    invoke: (invocation) => adapter.invoke(invocation),
  };
}
