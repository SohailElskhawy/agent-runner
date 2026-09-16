import { CliError } from "./errors.js";

export type ParsedCommand =
  | { readonly name: "init" }
  | { readonly name: "run"; readonly taskId: string }
  | { readonly name: "status" }
  | { readonly name: "inspect"; readonly taskId: string }
  | { readonly name: "tasks"; readonly action: "add"; readonly taskFile: string }
  | { readonly name: "agents" }
  | { readonly name: "help" }
  | { readonly name: "version" };

export const KNOWN_COMMANDS = [
  "init",
  "run",
  "status",
  "inspect",
  "tasks",
  "agents",
  "help",
  "version",
] as const;

export function parseArgs(argv: readonly string[]): ParsedCommand {
  const [command, ...rest] = argv;
  if (command === undefined || command === "") {
    return { name: "help" };
  }
  switch (command) {
    case "init":
      requireNoExtraArguments(command, rest);
      return { name: "init" };
    case "run":
      return { name: "run", taskId: requireTaskId(command, rest) };
    case "status":
      requireNoExtraArguments(command, rest);
      return { name: "status" };
    case "inspect":
      return { name: "inspect", taskId: requireTaskId(command, rest) };
    case "tasks":
      return parseTasksCommand(rest);
    case "agents":
      requireNoExtraArguments(command, rest);
      return { name: "agents" };
    case "--help":
    case "-h":
    case "help":
      requireNoExtraArguments("help", rest);
      return { name: "help" };
    case "--version":
    case "-v":
    case "version":
      requireNoExtraArguments("version", rest);
      return { name: "version" };
    default:
      throw new CliError(
        `unknown command "${command}"; known commands: ${KNOWN_COMMANDS.join(", ")}`,
      );
  }
}

function requireTaskId(
  command: "run" | "inspect",
  rest: readonly string[],
): string {
  const [taskId, ...extra] = rest;
  if (taskId === undefined || taskId.trim().length === 0) {
    throw new CliError(`command "${command}" requires a <task-id> argument`);
  }
  if (extra.length > 0) {
    throw new CliError(
      `command "${command}" accepts exactly one <task-id> argument`,
    );
  }
  return taskId;
}

const TASKS_SUBCOMMANDS = ["add"] as const;

function parseTasksCommand(rest: readonly string[]): ParsedCommand {
  const [subcommand, taskFile, ...extra] = rest;
  if (subcommand === undefined || subcommand.trim().length === 0) {
    throw new CliError(
      `command "tasks" requires a subcommand; usage: agentic tasks add <task-file>`,
    );
  }
  if (!(TASKS_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
    throw new CliError(
      `unknown tasks subcommand "${subcommand}"; supported subcommands: ${TASKS_SUBCOMMANDS.join(", ")}`,
    );
  }
  if (taskFile === undefined || taskFile.trim().length === 0) {
    throw new CliError(`command "tasks add" requires a <task-file> argument`);
  }
  if (extra.length > 0) {
    throw new CliError(
      `command "tasks add" accepts exactly one <task-file> argument`,
    );
  }
  return { name: "tasks", action: "add", taskFile };
}

function requireNoExtraArguments(
  command: string,
  rest: readonly string[],
): void {
  if (rest.length > 0) {
    throw new CliError(`command "${command}" does not accept extra arguments`);
  }
}

export const USAGE = `Usage:
  agentic init
  agentic run <task-id>
  agentic status
  agentic inspect <task-id>
  agentic tasks add <task-file>
  agentic agents
  agentic help
  agentic version

"agents" reports which built-in coding-agent CLIs are locally available.
"tasks add" parses one JSON task file written in the documented task schema
format (docs/TASK_SCHEMA.md), normalizes it to the runner task contract,
validates it, and persists it into local runner state. Manual task ingestion
only.

Local runner state (SQLite database and task worktrees) lives outside the
repository, per machine, keyed to the normalized repository path. Moving or
renaming the repository directory therefore creates a new local state
identity; no state migration is performed.

Verification commands come from explicit runner configuration. Tasks that
require verification checks with no configured command are rejected before
execution.`;
