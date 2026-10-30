import { CliError } from "./errors.js";

export type ParsedCommand =
  | { readonly name: "init" }
  | { readonly name: "run"; readonly taskId?: string; readonly parallel?: number }
  | { readonly name: "run-all"; readonly parallel?: number }
  | { readonly name: "pause"; readonly reason?: string }
  | { readonly name: "resume" }
  | { readonly name: "status" }
  | { readonly name: "inspect"; readonly taskId: string; readonly usage?: true }
  | { readonly name: "approve"; readonly taskId: string }
  | { readonly name: "retry"; readonly taskId: string }
  | { readonly name: "tasks"; readonly action: "list" }
  | { readonly name: "tasks"; readonly action: "add"; readonly taskFile: string }
  | { readonly name: "analyze" }
  | { readonly name: "plan"; readonly goal: string }
  | { readonly name: "plan"; readonly action: "show"; readonly planId?: string }
  | { readonly name: "plan"; readonly action: "approve"; readonly planId: string }
  | { readonly name: "doctor" }
  | { readonly name: "agents" }
  | { readonly name: "help" }
  | { readonly name: "version" };

export const KNOWN_COMMANDS = [
  "init",
  "run",
  "run-all",
  "pause",
  "resume",
  "status",
  "inspect",
  "approve",
  "retry",
  "tasks",
  "analyze",
  "plan",
  "doctor",
  "agents",
  "help",
  "version",
] as const;

export function parseArgs(argv: readonly string[]): ParsedCommand {
  const [command, ...rest] = argv;
  if (command === undefined || command === "") {
    return { name: "help" };
  }
  if (command !== "inspect" && rest.includes("--usage") && ["run", "approve", "retry"].includes(command)) {
    throw new CliError('--usage is only supported by "inspect"');
  }
  switch (command) {
    case "init":
      requireNoExtraArguments(command, rest);
      return { name: "init" };
    case "run":
      return parseRunCommand(rest);
    case "run-all":
      return { name: "run-all", ...parseParallelOption("run-all", rest) };
    case "pause":
      if (rest.length === 0) return { name: "pause" };
      if (rest.length !== 2 || rest[0] !== "--reason" || (rest[1] === undefined || rest[1].trim().length === 0)) throw new CliError('command "pause" accepts --reason <non-empty text>');
      return { name: "pause", reason: rest[1] };
    case "resume":
      requireNoExtraArguments(command, rest);
      return { name: "resume" };
    case "status":
      requireNoExtraArguments(command, rest);
      return { name: "status" };
    case "inspect":
      if (rest.length === 2 && rest[1] === "--usage" && rest[0] !== undefined && rest[0] !== "--usage") {
        return { name: "inspect", taskId: requireTaskId(command, [rest[0]]), usage: true };
      }
      if (rest[0] === "--usage") throw new CliError('command "inspect" requires a <task-id> argument');
      return { name: "inspect", taskId: requireTaskId(command, rest) };
    case "approve":
      return { name: "approve", taskId: requireTaskId(command, rest) };
    case "retry":
      return { name: "retry", taskId: requireTaskId(command, rest) };
    case "tasks":
      return parseTasksCommand(rest);
    case "analyze":
      requireNoExtraArguments(command, rest);
      return { name: "analyze" };
    case "plan":
      return parsePlanCommand(rest);
    case "doctor":
      requireNoExtraArguments(command, rest);
      return { name: "doctor" };
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
  command: "run" | "inspect" | "approve" | "retry",
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

const PARALLEL_FLAG = "--parallel";

/**
 * Parses an optional `--parallel <n>` option. `n` must be a positive integer
 * (>= 1); invalid values are rejected deterministically and never normalized.
 */
function parseParallelOption(
  command: string,
  rest: readonly string[],
): { readonly parallel?: number } {
  const index = rest.indexOf(PARALLEL_FLAG);
  if (index < 0) {
    return {};
  }
  const value = rest[index + 1];
  if (value === undefined) {
    throw new CliError(
      `command "${command}" requires a value for ${PARALLEL_FLAG} (a positive integer)`,
    );
  }
  const remaining = [...rest.slice(0, index), ...rest.slice(index + 2)];
  const parallel = parseParallelValue(command, value);
  if (remaining.length > 0) {
    throw new CliError(
      `command "${command}" accepts at most ${PARALLEL_FLAG} <n> as an option`,
    );
  }
  return { parallel };
}

function parseParallelValue(command: string, value: string): number {
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < 1 ||
    value.trim().length === 0
  ) {
    throw new CliError(
      `command "${command}" requires ${PARALLEL_FLAG} to be a positive integer (>= 1), received "${value}"`,
    );
  }
  return parsed;
}

function parseRunCommand(rest: readonly string[]): ParsedCommand {
  const parallelIndex = rest.indexOf(PARALLEL_FLAG);
  if (parallelIndex < 0) {
    return parseRunTaskId(rest, undefined);
  }
  const value = rest[parallelIndex + 1];
  if (value === undefined) {
    throw new CliError(
      `command "run" requires a value for ${PARALLEL_FLAG} (a positive integer)`,
    );
  }
  const parallel = parseParallelValue("run", value);
  const withoutOption = [
    ...rest.slice(0, parallelIndex),
    ...rest.slice(parallelIndex + 2),
  ];
  if (withoutOption.length > 0) {
    return parseRunTaskId(withoutOption, parallel);
  }
  return { name: "run", parallel };
}

function parseRunTaskId(rest: readonly string[], parallel: number | undefined): ParsedCommand {
  const [taskId, ...extra] = rest;
  if (taskId === undefined) {
    return parallel === undefined ? { name: "run" } : { name: "run", parallel };
  }
  if (taskId.trim().length === 0) {
    throw new CliError('command "run" does not accept an empty <task-id>');
  }
  if (extra.length > 0) {
    throw new CliError(
      'command "run" accepts at most one <task-id> argument',
    );
  }
  if (parallel !== undefined) {
    throw new CliError(
      `command "run" does not accept ${PARALLEL_FLAG} with a <task-id>; single-task execution is sequential and "${PARALLEL_FLAG}" only configures unattended scheduling`,
    );
  }
  return { name: "run", taskId };
}

function parsePlanCommand(rest: readonly string[]): ParsedCommand {
  if (rest[0] === "show") {
    const planId = rest[1];
    if (rest.length > 2) throw new CliError('command "plan show" accepts at most one <plan-id> argument');
    if (planId !== undefined && planId.trim().length === 0) throw new CliError('command "plan show" does not accept an empty <plan-id>');
    return planId === undefined ? { name: "plan", action: "show" } : { name: "plan", action: "show", planId };
  }
  if (rest[0] === "approve") {
    const planId = rest[1];
    if (planId === undefined || planId.trim().length === 0) throw new CliError('command "plan approve" requires a <plan-id> argument');
    if (rest.length > 2) throw new CliError('command "plan approve" accepts exactly one <plan-id> argument');
    return { name: "plan", action: "approve", planId };
  }
  if (rest[0] !== "--goal") throw new CliError('command "plan" requires --goal <text> or "plan show [<plan-id>]"');
  const goal = rest[1];
  if (goal === undefined || goal.trim().length === 0) throw new CliError('command "plan" requires a non-empty value for --goal');
  if (rest.length > 2) throw new CliError('command "plan --goal" accepts exactly one <text> argument');
  return { name: "plan", goal };
}

const TASKS_SUBCOMMANDS = ["add"] as const;

function parseTasksCommand(rest: readonly string[]): ParsedCommand {
  const [subcommand, taskFile, ...extra] = rest;
  if (subcommand === undefined) {
    return { name: "tasks", action: "list" };
  }
  if (!(TASKS_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
    throw new CliError(
      `unknown tasks subcommand "${subcommand}"; supported subcommands: ${TASKS_SUBCOMMANDS.join(", ")} (or no subcommand to list tasks)`,
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
  agentic run [--parallel <n>]
  agentic run-all [--parallel <n>]
  agentic pause [--reason <text>]
  agentic resume
  agentic status
  agentic inspect <task-id> [--usage]
  agentic approve <task-id>
  agentic retry <task-id>
  agentic tasks [add <task-file>]
  agentic analyze
  agentic plan --goal <text>
  agentic plan show [<plan-id>]
  agentic plan approve <plan-id>
  agentic doctor
  agentic agents
  agentic help
  agentic version

"run <task-id>" executes the task's resolved workflow (default: PLAN ->
PLAN_REVIEW -> IMPLEMENT -> CODE_REVIEW -> VERIFY -> INTEGRATE) with
integration verification before DONE.
"run" with no task id starts unattended DAG execution of every runnable task.
"--parallel <n>" configures how many tasks the unattended scheduler may run
concurrently for that run (a positive integer, default 1). "run-all" is a
compatibility alias for unattended "run".

"pause" stops new task admissions and lets in-flight work drain; "resume" allows
new execution. "status" shows the durable control state.

"inspect <task-id> --usage" shows per-attempt reported usage evidence.
Project planning is excluded; workflow PLAN is included. Provider usage parsers
are not yet supported.

"agents" reports which built-in coding-agent CLIs are locally available.
"doctor" runs local preflight checks (Node, Git, project state, configuration,
coding agents, and the worktrees directory), reports PASS/WARN/FAIL per check,
and exits non-zero when any check fails.
"tasks" with no subcommand lists the persisted tasks with their status,
priority, milestone, dependencies, attempt count, and approval state.
"tasks add" parses one JSON task file written in the documented task schema
format (docs/TASK_SCHEMA.md), normalizes it to the runner task contract,
validates it, and persists it into local runner state. Manual task ingestion
only.

"approve" records human approval for a task that declares approval.required: true.

"retry" returns a FAILED, NEEDS_HUMAN, or BLOCKED task to READY so the runner may
execute it again. Retry respects the task attempt budget (limits.max_attempts);
tasks that exhausted their budget must raise limits.max_attempts and be re-added.
Tasks that declare approval.required: true must be approved with "agentic approve"
first. Previous dirty worktrees are retained for inspection.

Local runner state (SQLite database and task worktrees) lives outside the
repository, per machine, keyed to the normalized repository path. Moving or
renaming the repository directory therefore creates a new local state
identity; no state migration is performed.

Verification commands come from explicit runner configuration. Tasks that
require verification checks with no configured command are rejected before
execution.`;
