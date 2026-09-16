import type { ContextPack } from "@agentic-dev-runner/core";
import type { AgentExecutionResult } from "./agent-result.js";

export type AgentDescriptor = {
  readonly id: string;
  readonly model?: string | undefined;
  readonly capabilities?: readonly string[] | undefined;
};

export type AgentInvocation = {
  readonly agent: AgentDescriptor;
  readonly contextPack: ContextPack;
  readonly worktreePath: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  /**
   * Provider-independent stage directive (for example, the PLAN stage asks
   * for an implementation plan instead of source implementation). Adapters
   * decide how to render this instruction inside their provider prompt.
   */
  readonly instruction?: string | undefined;
};

export interface AgentRuntime {
  readonly descriptor: AgentDescriptor;
  invoke(invocation: AgentInvocation): Promise<AgentExecutionResult>;
}
