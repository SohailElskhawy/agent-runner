#!/usr/bin/env node
import process from "node:process";
import { runCli } from "./run-cli.js";
import { createServices } from "./wiring.js";

const exitCode = await runCli(process.argv.slice(2), {
  servicesFactory: createServices,
});
process.exitCode = exitCode;
