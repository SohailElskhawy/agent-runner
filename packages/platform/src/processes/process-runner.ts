export type ProcessEnvironment = Readonly<Record<string, string>>;

export type ProcessSpec = {
  readonly executable: string;
  readonly args?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly env?: ProcessEnvironment | undefined;
  readonly timeoutMs?: number | undefined;
  readonly killGraceMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
};

export type ProcessOutcome =
  | { readonly kind: "completed"; readonly code: number }
  | { readonly kind: "terminated"; readonly signal: string }
  | { readonly kind: "timeout" }
  | { readonly kind: "cancelled" }
  | {
      readonly kind: "spawn-error";
      readonly code: string;
      readonly message: string;
    };

export type ProcessResult = {
  readonly outcome: ProcessOutcome;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
};

export interface ProcessRunner {
  run(spec: ProcessSpec): Promise<ProcessResult>;
}
