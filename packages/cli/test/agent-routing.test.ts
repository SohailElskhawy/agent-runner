import { describe, expect, it } from "vitest";
import type { AgentProfile } from "@agentic-dev-runner/core";
import type {
  AgentAvailability,
  AgentDescriptor,
  AgentExecutionResult,
  AgentInvocation,
  AgentRegistry,
  AgentRuntime,
} from "@agentic-dev-runner/agents";
import { createAgentAdapterRegistry } from "../src/application/agents/agent-adapter-registry.js";
import type { AgentAdapterRegistry } from "../src/application/agents/agent-adapter-registry.js";
import { resolveRoutedAgent } from "../src/application/agents/agent-routing.js";
import { createFixtureTask } from "./fixtures.js";

class StubAgentRuntime implements AgentRuntime {
  constructor(readonly descriptor: AgentDescriptor) {}

  async invoke(): Promise<AgentExecutionResult> {
    throw new Error("stub agent runtime must not be invoked in routing tests");
  }
}

class RecordingAgentRuntime implements AgentRuntime {
  readonly invocations: AgentInvocation[] = [];

  constructor(readonly descriptor: AgentDescriptor) {}

  async invoke(invocation: AgentInvocation): Promise<AgentExecutionResult> {
    this.invocations.push(invocation);
    return { kind: "success", output: {}, exitCode: 0, durationMs: 1 };
  }
}

function registryWith(records: readonly AgentAvailability[]): AgentRegistry {
  return {
    agentIds: records.map((record) => record.id),
    discoverAgents: async () => records,
  };
}

function adapterRegistryWith(
  adapters: Readonly<Record<string, AgentRuntime>>,
): AgentAdapterRegistry {
  const ids = Object.keys(adapters);
  return {
    adapterIds: ids,
    resolveAdapter: (adapterId) => adapters[adapterId] ?? null,
  };
}

const codexProfile: AgentProfile = {
  id: "codex-profile",
  adapterId: "codex",
  capabilities: ["typescript", "debugging"],
};

const opencodeProfile: AgentProfile = {
  id: "opencode-profile",
  adapterId: "opencode",
  model: "openai/gpt-5",
  capabilities: ["typescript", "javascript"],
};

const availableFor = (id: string): AgentAvailability => ({
  id,
  available: true,
  version: `${id} 1.0.0`,
  reason: null,
});

const unavailableFor = (id: string, reason: string): AgentAvailability => ({
  id,
  available: false,
  version: null,
  reason,
});

function routing(input: {
  requiredCapabilities: readonly string[];
  profiles?: readonly AgentProfile[];
  availability?: readonly AgentAvailability[];
  adapters?: Readonly<Record<string, AgentRuntime>>;
}) {
  const codexRuntime = new StubAgentRuntime({ id: "codex" });
  const opencodeRuntime = new StubAgentRuntime({ id: "opencode" });
  return resolveRoutedAgent({
    requiredCapabilities: input.requiredCapabilities,
    agentProfiles: input.profiles ?? [opencodeProfile, codexProfile],
    agents: registryWith(input.availability ?? [
      availableFor("opencode"),
      availableFor("codex"),
    ]),
    adapters: input.adapters === undefined
      ? adapterRegistryWith({
          opencode: opencodeRuntime,
          codex: codexRuntime,
        })
      : adapterRegistryWith(input.adapters),
  });
}

describe("resolveRoutedAgent", () => {
  it("selects the codex profile when only codex declares the required capability", async () => {
    const selection = await routing({ requiredCapabilities: ["debugging"] });

    expect(selection.routed).toBe(true);
    if (!selection.routed) return;
    expect(selection.profile.id).toBe("codex-profile");
    expect(selection.runtime.descriptor.id).toBe("codex");
  });

  it("selects the opencode profile when only opencode declares the required capability", async () => {
    const selection = await routing({ requiredCapabilities: ["javascript"] });

    expect(selection.routed).toBe(true);
    if (!selection.routed) return;
    expect(selection.profile.id).toBe("opencode-profile");
    expect(selection.runtime.descriptor.id).toBe("opencode");
  });

  it("selects the first configured profile when several are eligible", async () => {
    const selection = await routing({ requiredCapabilities: ["typescript"] });

    expect(selection.routed).toBe(true);
    if (!selection.routed) return;
    expect(selection.profile.id).toBe("opencode-profile");
  });

  it("falls through an unavailable adapter to the next eligible available profile", async () => {
    const selection = await routing({
      requiredCapabilities: ["typescript"],
      availability: [
        unavailableFor("opencode", "opencode could not be started"),
        availableFor("codex"),
      ],
    });

    expect(selection.routed).toBe(true);
    if (!selection.routed) return;
    expect(selection.profile.id).toBe("codex-profile");
  });

  it("excludes profiles whose declared capabilities do not cover the task", async () => {
    const selection = await routing({
      requiredCapabilities: ["rust"],
      profiles: [opencodeProfile, codexProfile],
    });

    expect(selection.routed).toBe(false);
    if (selection.routed) return;
    expect(selection.reason).toContain('profile "opencode-profile" is missing required capabilities: rust');
    expect(selection.reason).toContain('profile "codex-profile" is missing required capabilities: rust');
  });

  it("treats an unknown configured adapter id as unavailable instead of crashing or falling back", async () => {
    const unknownProfile: AgentProfile = {
      id: "unknown-profile",
      adapterId: "claude",
      capabilities: ["typescript"],
    };
    const selection = await routing({
      requiredCapabilities: ["typescript"],
      profiles: [unknownProfile],
    });

    expect(selection.routed).toBe(false);
    if (selection.routed) return;
    expect(selection.reason).toContain('references unknown adapter "claude" with no discovery result');
    expect(selection.reason).not.toContain("opencode");
  });

  it("fails clearly when no agent profiles are configured", async () => {
    const selection = await routing({
      requiredCapabilities: ["typescript"],
      profiles: [],
    });

    expect(selection.routed).toBe(false);
    if (selection.routed) return;
    expect(selection.reason).toContain("no agent profiles are configured");
  });

  it("propagates the selected profile model onto the invocation descriptor", async () => {
    const recording = new RecordingAgentRuntime({ id: "opencode" });
    const selection = await resolveRoutedAgent({
      requiredCapabilities: ["javascript"],
      agentProfiles: [opencodeProfile],
      agents: registryWith([availableFor("opencode")]),
      adapters: adapterRegistryWith({ opencode: recording }),
    });

    expect(selection.routed).toBe(true);
    if (!selection.routed) return;
    expect(selection.runtime.descriptor.model).toBe("openai/gpt-5");

    const invocation: AgentInvocation = {
      agent: selection.runtime.descriptor,
      contextPack: {
        task: createFixtureTask(),
        agentsMarkdownPath: "AGENTS.md",
        agentsMarkdown: "# rules",
        documents: [],
        scope: { allowedPaths: ["**"], forbiddenPaths: [] },
        baseRevision: "base",
        manifest: { entries: [], createdAt: "2026-01-01T00:00:00.000Z" },
      },
      worktreePath: "fixture/worktree",
      timeoutMs: 1_000,
    };
    const result = await selection.runtime.invoke(invocation);

    expect(result.kind).toBe("success");
    expect(recording.invocations).toHaveLength(1);
    expect(recording.invocations[0]?.agent.model).toBe("openai/gpt-5");
  });

  it("joins profiles to availability by adapter id rather than array position", async () => {
    const selection = await routing({
      requiredCapabilities: ["javascript"],
      availability: [
        availableFor("codex"),
        unavailableFor("opencode", "opencode missing"),
      ],
    });

    expect(selection.routed).toBe(false);
    if (selection.routed) return;
    // Array position would pair the first profile (opencode) with the first
    // availability record (codex, available) and route the task. Identity
    // pairing by adapter id keeps the opencode profile unavailable, and the
    // codex profile is excluded because it lacks the required capability.
    expect(selection.reason).toContain(
      'profile "opencode-profile" cannot run because its adapter "opencode" is unavailable',
    );
    expect(selection.reason).toContain(
      'profile "codex-profile" is missing required capabilities: javascript',
    );
  });

  it("treats a profile whose adapter has no discovery result at all as unavailable", async () => {
    const selection = await routing({
      requiredCapabilities: ["typescript"],
      profiles: [opencodeProfile, codexProfile],
      availability: [availableFor("codex")],
    });

    expect(selection.routed).toBe(true);
    if (!selection.routed) return;
    expect(selection.profile.id).toBe("codex-profile");
  });

  it("reports diagnostics for unavailable adapters deterministically", async () => {
    const selection = await routing({
      requiredCapabilities: ["typescript"],
      availability: [
        unavailableFor("opencode", "opencode --version failed"),
        unavailableFor("codex", "codex --version failed"),
      ],
    });

    expect(selection.routed).toBe(false);
    if (selection.routed) return;
    expect(selection.reason).toContain('profile "opencode-profile" cannot run because its adapter "opencode" is unavailable');
    expect(selection.reason).toContain('profile "codex-profile" cannot run because its adapter "codex" is unavailable');
  });

  it("builds the default adapter registry from adapter descriptors", () => {
    const registry = createAgentAdapterRegistry([
      new StubAgentRuntime({ id: "opencode" }),
      new StubAgentRuntime({ id: "codex" }),
    ]);

    expect(registry.adapterIds).toEqual(["opencode", "codex"]);
    expect(registry.resolveAdapter("codex")?.descriptor.id).toBe("codex");
    expect(registry.resolveAdapter("claude")).toBeNull();
  });
});
