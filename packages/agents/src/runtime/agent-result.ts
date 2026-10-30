import type { InvocationUsageObservation } from "@agentic-dev-runner/core";

export type AgentOutput = {
  readonly stdout?: string | undefined;
  readonly stderr?: string | undefined;
};

export type AgentFailure = {
  readonly kind: "process" | "adapter";
  readonly message: string;
};

export type AgentExecutionResult =
  | {
      readonly kind: "success";
      readonly output: AgentOutput;
      readonly exitCode?: number | undefined;
      readonly durationMs: number;
      readonly usage?: InvocationUsageObservation | undefined;
    }
  | {
      readonly kind: "failure";
      readonly failure: AgentFailure;
      readonly output: AgentOutput;
      readonly durationMs: number;
      readonly usage?: InvocationUsageObservation | undefined;
    }
  | {
      readonly kind: "timeout";
      readonly output: AgentOutput;
      readonly durationMs: number;
      readonly usage?: InvocationUsageObservation | undefined;
    }
  | {
      readonly kind: "cancelled";
      readonly output: AgentOutput;
      readonly durationMs: number;
      readonly usage?: InvocationUsageObservation | undefined;
    };
