import { describe, expect, it } from "vitest";
import {
  evaluateAgentProfileEligibility,
  normalizeAgentCapability,
  validateAgentProfile,
  type AgentProfile,
  type AgentProfileEligibility,
} from "@agentic-dev-runner/core";

function profile(
  overrides: Partial<AgentProfile> = {},
): AgentProfile {
  return {
    id: "profile-1",
    adapterId: "opencode",
    capabilities: ["typescript", "react-native"],
    ...overrides,
  };
}

function eligibility(
  candidate: AgentProfile,
  required: readonly string[],
): AgentProfileEligibility {
  return evaluateAgentProfileEligibility(candidate, required);
}

describe("evaluateAgentProfileEligibility", () => {
  it("is eligible on an exact capability match", () => {
    expect(eligibility(profile(), ["typescript"])).toEqual({
      eligible: true,
      missingCapabilities: [],
    });
  });

  it("matches capabilities exactly after normalization, not by provider name", () => {
    expect(
      eligibility({ id: "codex-1", adapterId: "codex", capabilities: ["typescript"] }, [
        "typescript",
      ]),
    ).toEqual({ eligible: true, missingCapabilities: [] });
  });

  it("is eligible when all multiple required capabilities are declared", () => {
    expect(eligibility(profile(), ["typescript", "react-native"])).toEqual({
      eligible: true,
      missingCapabilities: [],
    });
  });

  it("is eligible for an empty task capability requirement regardless of the profile", () => {
    expect(
      eligibility({ id: "bare", adapterId: "codex", capabilities: [] }, []),
    ).toEqual({ eligible: true, missingCapabilities: [] });
    expect(eligibility(profile(), [])).toEqual({
      eligible: true,
      missingCapabilities: [],
    });
  });

  it("keeps a profile eligible when it declares additional capabilities", () => {
    expect(
      eligibility(
        profile({ capabilities: ["typescript", "react-native", "debugging"] }),
        ["react-native"],
      ),
    ).toEqual({ eligible: true, missingCapabilities: [] });
  });

  it("reports one missing capability and becomes ineligible", () => {
    expect(eligibility(profile(), ["debugging"])).toEqual({
      eligible: false,
      missingCapabilities: ["debugging"],
    });
  });

  it("reports multiple missing capabilities deterministically in requirement order", () => {
    expect(
      eligibility(profile(), ["debugging", "typescript", "swift", "kotlin"]),
    ).toEqual({
      eligible: false,
      missingCapabilities: ["debugging", "swift", "kotlin"],
    });
  });

  it("reports missing capabilities after normalizing both sides", () => {
    expect(
      eligibility(profile({ capabilities: ["TypeScript"] }), [
        "  TypeScript  ",
        "REACT-NATIVE",
      ]),
    ).toEqual({ eligible: false, missingCapabilities: ["react-native"] });
  });

  it("reports a duplicated missing requirement only once", () => {
    expect(eligibility(profile({ capabilities: [] }), ["swift", "swift"])).toEqual({
      eligible: false,
      missingCapabilities: ["swift"],
    });
  });
});

describe("normalizeAgentCapability", () => {
  it("trims surrounding whitespace and lowercases", () => {
    expect(normalizeAgentCapability("  React-Native ")).toBe("react-native");
    expect(normalizeAgentCapability("TYPESCRIPT")).toBe("typescript");
  });

  it("preserves internal characters so distinct labels stay distinct", () => {
    expect(normalizeAgentCapability("React Native")).toBe("react native");
    expect(normalizeAgentCapability("react-native")).toBe("react-native");
    expect(normalizeAgentCapability("React Native")).not.toBe(
      normalizeAgentCapability("react-native"),
    );
  });
});

describe("validateAgentProfile", () => {
  it("accepts a profile with id, adapterId, model, and normalized capabilities", () => {
    const result = validateAgentProfile({
      id: "general-coder",
      adapterId: "opencode",
      model: "gpt-5",
      capabilities: ["  TypeScript ", "REACT-native"],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        id: "general-coder",
        adapterId: "opencode",
        model: "gpt-5",
        capabilities: ["typescript", "react-native"],
      },
    });
  });

  it("accepts a profile without a model and with no declared capabilities", () => {
    const result = validateAgentProfile({
      id: "bare",
      adapterId: "codex",
      capabilities: [],
    });
    expect(result).toEqual({
      ok: true,
      value: { id: "bare", adapterId: "codex", capabilities: [] },
    });
  });

  it("rejects duplicate capabilities instead of deduplicating", () => {
    const result = validateAgentProfile({
      id: "dup",
      adapterId: "opencode",
      capabilities: ["typescript", "typescript"],
    });
    expect(result).toEqual({
      ok: false,
      issues: ['agent profile.capabilities: must not contain duplicate capability "typescript"'],
    });
  });

  it("rejects capabilities that are duplicates after normalization", () => {
    const result = validateAgentProfile({
      id: "dup-case",
      adapterId: "opencode",
      capabilities: ["TypeScript", " typescript "],
    });
    expect(result).toEqual({
      ok: false,
      issues: ['agent profile.capabilities: must not contain duplicate capability "typescript"'],
    });
  });

  it("rejects malformed ids, adapter ids, models, and capability entries", () => {
    const result = validateAgentProfile({
      id: " ",
      adapterId: "",
      model: 7,
      capabilities: ["typescript", "   "],
    });
    expect(result).toEqual({
      ok: false,
      issues: [
        "agent profile.id: must be a non-empty string",
        "agent profile.adapterId: must be a non-empty string",
        "agent profile.model: must be a non-empty string",
        "agent profile.capabilities[1]: must be a non-empty string",
      ],
    });
  });

  it("rejects unknown fields and non-object input", () => {
    expect(
      validateAgentProfile({
        id: "x",
        adapterId: "opencode",
        capabilities: [],
        runtime: { streaming: true },
      }),
    ).toEqual({
      ok: false,
      issues: ['agent profile: unknown field "runtime"'],
    });
    expect(validateAgentProfile(null)).toEqual({
      ok: false,
      issues: [
        "agent profile: must be an object with id, adapterId, model, and capabilities",
      ],
    });
  });
});
