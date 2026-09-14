export type CliIo = {
  readonly writeLine: (text: string) => void;
  readonly writeError: (text: string) => void;
};

export const consoleIo: CliIo = {
  writeLine: (text) => {
    process.stdout.write(`${text}\n`);
  },
  writeError: (text) => {
    process.stderr.write(`${text}\n`);
  },
};

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
