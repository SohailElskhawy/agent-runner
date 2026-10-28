import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { writeDiscoveryQuestions } from "../src/application/planning/plan-files.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile), mkdir: vi.fn(actual.mkdir), writeFile: vi.fn(actual.writeFile) };
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
