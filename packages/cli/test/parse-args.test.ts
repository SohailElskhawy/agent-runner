import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/parse-args.js";
import { CliError } from "../src/errors.js";

describe("CLI argument parsing", () => {
  it("parses init", () => {
    expect(parseArgs(["init"])).toEqual({ name: "init" });
  });

  it("parses run with a task id", () => {
    expect(parseArgs(["run", "M001"])).toEqual({ name: "run", taskId: "M001" });
  });

  it("parses task ids containing spaces", () => {
    expect(parseArgs(["run", "task 42 — fix header"])).toEqual({
      name: "run",
      taskId: "task 42 — fix header",
    });
  });

  it("parses status", () => {
    expect(parseArgs(["status"])).toEqual({ name: "status" });
  });

  it("parses agents", () => {
    expect(parseArgs(["agents"])).toEqual({ name: "agents" });
  });

  it("parses inspect with a task id", () => {
    expect(parseArgs(["inspect", "M001"])).toEqual({
      name: "inspect",
      taskId: "M001",
    });
  });

  it("parses help and version aliases", () => {
    expect(parseArgs([])).toEqual({ name: "help" });
    expect(parseArgs(["--help"])).toEqual({ name: "help" });
    expect(parseArgs(["-h"])).toEqual({ name: "help" });
    expect(parseArgs(["--version"])).toEqual({ name: "version" });
    expect(parseArgs(["-v"])).toEqual({ name: "version" });
    expect(parseArgs(["version"])).toEqual({ name: "version" });
  });

  it("rejects empty task ids", () => {
    expect(() => parseArgs(["run", ""])).toThrow(CliError);
    expect(() => parseArgs(["run", "   "])).toThrow(CliError);
    expect(() => parseArgs(["inspect", ""])).toThrow(CliError);
  });

  it("rejects missing task ids", () => {
    expect(() => parseArgs(["run"])).toThrow(CliError);
    expect(() => parseArgs(["inspect"])).toThrow(CliError);
  });

  it("rejects multiple task ids", () => {
    expect(() => parseArgs(["run", "M001", "M002"])).toThrow(CliError);
  });

  it("rejects extra arguments on argument-less commands", () => {
    expect(() => parseArgs(["init", "extra"])).toThrow(CliError);
    expect(() => parseArgs(["status", "extra"])).toThrow(CliError);
    expect(() => parseArgs(["agents", "extra"])).toThrow(CliError);
  });

  it("rejects unknown commands", () => {
    expect(() => parseArgs(["frobnicate"])).toThrow(CliError);
  });
});
