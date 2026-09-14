export type {
  AgentDescriptor,
  AgentInvocation,
  AgentRuntime,
} from "./runtime/agent-runtime.js";
export type {
  AgentExecutionResult,
  AgentFailure,
  AgentOutput,
} from "./runtime/agent-result.js";
export {
  OPENCODE_AGENT_ID,
  OpenCodeAdapter,
  OpenCodeAdapterError,
  type ContextDirectoryRemover,
  type OpenCodeAdapterOptions,
} from "./adapters/opencode/opencode-adapter.js";
