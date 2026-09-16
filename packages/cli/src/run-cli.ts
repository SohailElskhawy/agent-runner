import { CliError } from "./errors.js";
import { consoleIo, describeError, type CliIo } from "./io.js";
import { parseArgs, USAGE } from "./parse-args.js";
import type { ParsedCommand } from "./parse-args.js";
import {
  executeAddTaskCommand,
  executeAgentsCommand,
  executeInitCommand,
  executeInspectCommand,
  executeRunCommand,
  executeStatusCommand,
  EXIT_FAILURE,
} from "./commands/execute-commands.js";
import type { RunnerAppService } from "./application/runner-app-service.js";

export const EXIT_USAGE = 2;

export type CliServicesFactory = () =>
  | RunnerAppService
  | Promise<RunnerAppService>;

export type RunCliOptions = {
  readonly io?: CliIo | undefined;
  readonly servicesFactory?: CliServicesFactory | undefined;
};

export async function runCli(
  argv: readonly string[],
  options: RunCliOptions = {},
): Promise<number> {
  const io = options.io ?? consoleIo;
  let command: ParsedCommand;
  try {
    command = parseArgs(argv);
  } catch (error) {
    io.writeError(describeError(error));
    io.writeError(USAGE);
    return EXIT_USAGE;
  }
  try {
    switch (command.name) {
      case "help":
        io.writeLine(USAGE);
        return 0;
      case "version":
        io.writeLine("agentic 0.1.0");
        return 0;
      case "init":
      case "run":
      case "status":
      case "inspect":
      case "tasks":
      case "agents":
        return await withServices(options.servicesFactory, async (services) => {
          try {
            switch (command.name) {
              case "init":
                return await executeInitCommand(services, io);
              case "run":
                return await executeRunCommand(command.taskId, services, io);
              case "status":
                return await executeStatusCommand(services, io);
              case "inspect":
                return await executeInspectCommand(command.taskId, services, io);
              case "tasks":
                return await executeAddTaskCommand(
                  command.taskFile,
                  services,
                  io,
                );
              case "agents":
                return await executeAgentsCommand(services, io);
            }
          } finally {
            await closeServices(services, io);
          }
        });
    }
  } catch (error) {
    io.writeError(`error: ${describeError(error)}`);
    return EXIT_FAILURE;
  }
}

async function withServices<T>(
  servicesFactory: CliServicesFactory | undefined,
  body: (services: RunnerAppService) => Promise<T>,
): Promise<T> {
  const services = await resolveServices(servicesFactory);
  return body(services);
}

async function closeServices(
  services: RunnerAppService,
  io: CliIo,
): Promise<void> {
  try {
    await services.close();
  } catch (error) {
    io.writeError(`warning: closing runner state failed: ${describeError(error)}`);
  }
}

function resolveServices(
  servicesFactory: CliServicesFactory | undefined,
): Promise<RunnerAppService> {
  if (servicesFactory === undefined) {
    throw new CliError(
      "no application services are wired; provide a services factory",
    );
  }
  return Promise.resolve(servicesFactory());
}
