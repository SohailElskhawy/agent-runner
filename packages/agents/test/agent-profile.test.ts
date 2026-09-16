import { describe, expect, it } from "vitest";
import { createNodeProcessRunner } from "@agentic-dev-runner/platform";
import {
  evaluateAgentProfileEligibility,
  type AgentProfile,
} from "@agentic-dev-runner/core";
import {
  CODEX_AGENT_ID,
  CodexAdapter,
  OPENCODE_AGENT_ID,
  OpenCodeAdapter,
} from "../src/index.js";

describe("Agent capability profiles", () => {
  it("does not hard-code language or framework capabilities into adapters", () => {
    const opencode = new OpenCodeAdapter(createNodeProcessRunner());
    const codex = new CodexAdapter(createNodeProcessRunner());

    expect(opencode.descriptor).toEqual({ id: OPENCODE_AGENT_ID, capabilities: [] });
    expect(codex.descriptor).toEqual({ id: CODEX_AGENT_ID, capabilities: [] });
  });

  it("does not infer capabilities from provider names or runtime descriptors", () => {
    const opencode = new OpenCodeAdapter(createNodeProcessRunner());
    const fromDescriptor: AgentProfile = {
      id: opencode.descriptor.id,
      adapterId: opencode.descriptor.id,
      capabilities: opencode.descriptor.capabilities ?? [],
    };

    expect(evaluateAgentProfileEligibility(fromDescriptor, ["typescript"])).toEqual({
      eligible: false,
      missingCapabilities: ["typescript"],
    });
  });

  it("eligibility follows only explicitly declared task capabilities", () => {
    const undeclared: AgentProfile = {
      id: "opencode-general",
      adapterId: OPENCODE_AGENT_ID,
      capabilities: [],
    };
    expect(evaluateAgentProfileEligibility(undeclared, ["react-native"])).toEqual({
      eligible: false,
      missingCapabilities: ["react-native"],
    });

    const declared: AgentProfile = {
      id: "opencode-general",
      adapterId: OPENCODE_AGENT_ID,
      capabilities: ["typescript", "react-native"],
    };
    expect(evaluateAgentProfileEligibility(declared, ["react-native"])).toEqual({
      eligible: true,
      missingCapabilities: [],
    });
  });
});
