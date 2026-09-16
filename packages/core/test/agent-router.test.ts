import { describe, expect, it } from "vitest";
import {
  selectAgentProfile,
  type AgentProfile,
  type AgentRouteCandidate,
  type AgentRouteResult,
} from "@agentic-dev-runner/core";

function profile(
  overrides: Partial<AgentProfile> = {},
): AgentProfile {
  return {
    id: "profile-1",
    adapterId: "opencode",
    capabilities: ["typescript"],
    ...overrides,
  };
}

function candidate(
  overrides: Partial<AgentRouteCandidate> = {},
): AgentRouteCandidate {
  return {
    profile: profile(),
    availability: { id: "profile-1", available: true },
    ...overrides,
  };
}

function route(candidates: readonly AgentRouteCandidate[], required: readonly string[] = []): AgentRouteResult {
  return selectAgentProfile({ requiredCapabilities: required, candidates });
}

describe("selectAgentProfile", () => {
  it("selects the one available eligible profile", () => {
    const result = route([candidate()]);
    expect(result).toEqual({
      selected: true,
      profile: { id: "profile-1", adapterId: "opencode", capabilities: ["typescript"] },
    });
  });

  it("excludes an unavailable profile even when it is capable", () => {
    const result = route([
      candidate({ availability: { id: "profile-1", available: false } }),
    ]);
    expect(result).toEqual({
      selected: false,
      rejections: [{ reason: "adapter-unavailable", profileId: "profile-1" }],
    });
  });

  it("excludes a capability-missing profile even when it is available", () => {
    const result = route(
      [candidate({ profile: profile({ capabilities: ["typescript"] }) })],
      ["react-native"],
    );
    expect(result).toEqual({
      selected: false,
      rejections: [
        {
          reason: "missing-capabilities",
          profileId: "profile-1",
          missingCapabilities: ["react-native"],
        },
      ],
    });
  });

  it("rejects an available-but-ineligible and an unavailable-but-capable candidate", () => {
    const result = route(
      [
        candidate({ profile: profile({ capabilities: [] }) }),
        candidate({
          profile: profile({ id: "off", adapterId: "codex" }),
          availability: { id: "off", available: false },
        }),
      ],
      ["typescript"],
    );
    expect(result).toEqual({
      selected: false,
      rejections: [
        {
          reason: "missing-capabilities",
          profileId: "profile-1",
          missingCapabilities: ["typescript"],
        },
        { reason: "adapter-unavailable", profileId: "off" },
      ],
    });
  });

  it("uses the supplied candidate order as the deterministic tie-breaker", () => {
    const first = candidate({
      profile: profile({ id: "first", capabilities: ["typescript"] }),
      availability: { id: "first", available: true },
    });
    const second = candidate({
      profile: profile({ id: "second", capabilities: ["typescript"] }),
      availability: { id: "second", available: true },
    });
    const result = route([first, second], ["typescript"]);
    if (!result.selected) {
      throw new Error("expected a selection");
    }
    expect(result.profile.id).toBe("first");
    expect(route([second, first], ["typescript"])).toEqual({
      selected: true,
      profile: { id: "second", adapterId: "opencode", capabilities: ["typescript"] },
    });
  });

  it("selects a profile when the task declares no capabilities", () => {
    const result = route([
      candidate({ profile: profile({ capabilities: [] }) }),
      candidate({
        profile: profile({ id: "second" }),
        availability: { id: "second", available: true },
      }),
    ]);
    if (!result.selected) {
      throw new Error("expected a selection");
    }
    expect(result.profile.id).toBe("profile-1");
  });

  it("returns a structured no-route result with no rejections when there are no candidates", () => {
    expect(route([])).toEqual({ selected: false, rejections: [] });
  });

  it("reports every candidate as adapter-unavailable when none are available", () => {
    const result = route([
      candidate({
        profile: profile({ id: "a", capabilities: ["typescript"] }),
        availability: { id: "a", available: false },
      }),
      candidate({
        profile: profile({ id: "b", capabilities: [] }),
        availability: { id: "b", available: false },
      }),
    ]);
    expect(result).toEqual({
      selected: false,
      rejections: [
        { reason: "adapter-unavailable", profileId: "a" },
        { reason: "adapter-unavailable", profileId: "b" },
      ],
    });
  });

  it("reports every candidate as capability-ineligible when none declare the requirements", () => {
    const result = route(
      [
        candidate({ profile: profile({ id: "a", capabilities: ["typescript"] }) }),
        candidate({ profile: profile({ id: "b", capabilities: [] }) }),
      ],
      ["react-native", "swift"],
    );
    expect(result).toEqual({
      selected: false,
      rejections: [
        {
          reason: "missing-capabilities",
          profileId: "a",
          missingCapabilities: ["react-native", "swift"],
        },
        {
          reason: "missing-capabilities",
          profileId: "b",
          missingCapabilities: ["react-native", "swift"],
        },
      ],
    });
  });

  it("reports mixed rejection reasons in supplied order with unavailable precedence", () => {
    const result = route(
      [
        candidate({
          profile: profile({ id: "unavailable", capabilities: [] }),
          availability: { id: "unavailable", available: false },
        }),
        candidate({
          profile: profile({ id: "eligible", capabilities: ["typescript"] }),
          availability: { id: "eligible", available: true },
        }),
      ],
      ["typescript"],
    );
    expect(result).toEqual({
      selected: true,
      profile: { id: "eligible", adapterId: "opencode", capabilities: ["typescript"] },
    });

    const noRoute = route(
      [
        candidate({
          profile: profile({ id: "both", capabilities: [] }),
          availability: { id: "both", available: false },
        }),
        candidate({
          profile: profile({ id: "missing", capabilities: [] }),
          availability: { id: "missing", available: true },
        }),
      ],
      ["typescript"],
    );
    expect(noRoute).toEqual({
      selected: false,
      rejections: [
        { reason: "adapter-unavailable", profileId: "both" },
        {
          reason: "missing-capabilities",
          profileId: "missing",
          missingCapabilities: ["typescript"],
        },
      ],
    });
  });

  it("produces identical diagnostics for identical inputs", () => {
    const candidates = [
      candidate({
        profile: profile({ id: "down", capabilities: [] }),
        availability: { id: "down", available: false },
      }),
      candidate({
        profile: profile({ id: "missing", capabilities: ["typescript"] }),
        availability: { id: "missing", available: true },
      }),
    ];
    const first = route(candidates, ["Debugging", "  TYPESCRIPT "]);
    const second = route(candidates, ["Debugging", "  TYPESCRIPT "]);
    expect(first).toEqual({
      selected: false,
      rejections: [
        { reason: "adapter-unavailable", profileId: "down" },
        {
          reason: "missing-capabilities",
          profileId: "missing",
          missingCapabilities: ["debugging"],
        },
      ],
    });
    expect(second).toEqual(first);
  });

  it("never gives a provider identity special priority", () => {
    const result = route(
      [
        candidate({
          profile: profile({ id: "codex", adapterId: "codex" }),
          availability: { id: "codex", available: true },
        }),
        candidate({
          profile: profile({ id: "opencode", adapterId: "opencode" }),
          availability: { id: "opencode", available: true },
        }),
      ],
      [],
    );
    if (!result.selected) {
      throw new Error("expected a selection");
    }
    expect(result.profile.id).toBe("codex");
    const reversed = route(
      [
        candidate({
          profile: profile({ id: "opencode", adapterId: "opencode" }),
          availability: { id: "opencode", available: true },
        }),
        candidate({
          profile: profile({ id: "codex", adapterId: "codex" }),
          availability: { id: "codex", available: true },
        }),
      ],
      [],
    );
    if (!reversed.selected) {
      throw new Error("expected a selection");
    }
    expect(reversed.profile.id).toBe("opencode");
  });
});
