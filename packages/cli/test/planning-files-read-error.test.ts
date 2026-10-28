import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { writeDiscoveryQuestions } from "../src/application/planning/plan-files.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile), mkdir: vi.fn(actual.mkdir), writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename), rm: vi.fn(actual.rm) };
});

it("propagates a discovery read failure without modifying existing decisions", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "agentic-discovery-read-error-"));
  const directory = join(projectRoot, ".agentic");
  const path = join(directory, "decisions.md");
  const decisions = "# Decisions\n\n### AUTH: Sign in?\nAnswer: Email only\n";
  try {
    mkdirSync(directory);
    writeFileSync(path, decisions);
    const error = Object.assign(new Error("read failed"), { code: "EACCES" });
    vi.mocked(readFile).mockRejectedValueOnce(error);

    await expect(writeDiscoveryQuestions(projectRoot, [])).rejects.toBe(error);
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(readFileSync(path, "utf8")).toBe(decisions);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

it("preserves decisions and removes the temporary file when rename fails", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "agentic-discovery-rename-error-"));
  const directory = join(projectRoot, ".agentic");
  const path = join(directory, "decisions.md");
  const decisions = Buffer.from("# Decisions\r\nAnswer: original\r\n");
  try {
    mkdirSync(directory);
    writeFileSync(path, decisions);
    const error = new Error("rename failed");
    vi.mocked(rename).mockRejectedValueOnce(error);
    await expect(writeDiscoveryQuestions(projectRoot, [])).rejects.toBe(error);
    expect(readFileSync(path)).toEqual(decisions);
    expect(readdirSync(directory)).toEqual(["decisions.md"]);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

it("removes a partially written temporary file and preserves the write error", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "agentic-discovery-write-error-"));
  const directory = join(projectRoot, ".agentic");
  const path = join(directory, "decisions.md");
  const decisions = Buffer.from("original bytes\r\n");
  try {
    mkdirSync(directory);
    writeFileSync(path, decisions);
    const error = new Error("write failed");
    vi.mocked(writeFile).mockImplementationOnce(async (file) => {
      if (typeof file !== "string") throw new Error("expected a temporary path");
      writeFileSync(file, "partial");
      throw error;
    });
    await expect(writeDiscoveryQuestions(projectRoot, [])).rejects.toBe(error);
    expect(readFileSync(path)).toEqual(decisions);
    expect(readdirSync(directory)).toEqual(["decisions.md"]);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

it("leaves no temporary file after a successful replacement", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "agentic-discovery-success-"));
  const directory = join(projectRoot, ".agentic");
  try {
    await writeDiscoveryQuestions(projectRoot, []);
    expect(readFileSync(join(directory, "decisions.md"), "utf8")).toBe("# Planning decisions\n");
    expect(readdirSync(directory)).toEqual(["decisions.md"]);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

it("preserves the original error if temporary-file cleanup fails", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "agentic-discovery-cleanup-error-"));
  try {
    const error = new Error("rename failed");
    vi.mocked(rename).mockRejectedValueOnce(error);
    vi.mocked(rm).mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(writeDiscoveryQuestions(projectRoot, [])).rejects.toBe(error);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
