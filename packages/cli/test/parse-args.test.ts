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

  it("parses unattended execution", () => {
    expect(parseArgs(["run-all"])).toEqual({ name: "run-all" });
  });

  it("parses unattended run with no task id", () => {
    expect(parseArgs(["run"])).toEqual({ name: "run" });
  });

  it("parses unattended run with a parallel option", () => {
    expect(parseArgs(["run", "--parallel", "3"])).toEqual({
      name: "run",
      parallel: 3,
    });
    expect(parseArgs(["run-all", "--parallel", "1"])).toEqual({
      name: "run-all",
      parallel: 1,
    });
  });

  it("rejects invalid parallel values", () => {
    for (const value of ["0", "-1", "abc", "2.5", ""]) {
      expect(() => parseArgs(["run", "--parallel", value])).toThrow(CliError);
    }
    expect(() => parseArgs(["run", "--parallel"])).toThrow(CliError);
  });

  it("rejects parallel combined with a task id", () => {
    expect(() => parseArgs(["run", "M001", "--parallel", "2"])).toThrow(CliError);
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

  it("parses bare tasks as a list command", () => {
    expect(parseArgs(["tasks"])).toEqual({ name: "tasks", action: "list" });
  });

  it("parses tasks add with a task file", () => {
    expect(parseArgs(["tasks", "add", "./tasks/T1.json"])).toEqual({
      name: "tasks",
      action: "add",
      taskFile: "./tasks/T1.json",
    });
  });

  it("parses inspect with a task id", () => {
    expect(parseArgs(["inspect", "M001"])).toEqual({
      name: "inspect",
      taskId: "M001",
    });
  });

  it("parses the approve command with an explicit task id", () => {
    expect(parseArgs(["approve", "T1"])).toEqual({ name: "approve", taskId: "T1" });
  });

  it("rejects approve without a task id", () => {
    expect(() => parseArgs(["approve"])).toThrow(/requires a <task-id> argument/);
  });

  it("parses the retry command with an explicit task id", () => {
    expect(parseArgs(["retry", "T1"])).toEqual({ name: "retry", taskId: "T1" });
  });

  it("rejects retry without a task id", () => {
    expect(() => parseArgs(["retry"])).toThrow(/requires a <task-id> argument/);
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
