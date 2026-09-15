import { readFileSync } from "node:fs";
import { CliError } from "../errors.js";
import { describeError } from "../io.js";

export function readTaskFile(filePath: string): unknown {
  const content = readTaskFileContent(filePath);
  return parseTaskFileJson(content, filePath);
}

function readTaskFileContent(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    if (isErrnoException(error)) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") {
        throw new CliError(`task file "${filePath}" does not exist`);
      }
      if (error.code === "EISDIR") {
        throw new CliError(`task file "${filePath}" is a directory, not a file`);
      }
    }
    throw new CliError(
      `cannot read task file "${filePath}": ${describeError(error)}`,
    );
  }
}

function parseTaskFileJson(content: string, filePath: string): unknown {
  try {
    return JSON.parse(stripUtf8Bom(content)) as unknown;
  } catch (error) {
    throw new CliError(
      `task file "${filePath}" is not valid JSON: ${describeError(error)}`,
    );
  }
}

function stripUtf8Bom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    typeof (error as NodeJS.ErrnoException).code === "string"
  );
}
