import { describe, expect, it } from "vitest";
import { CORE_PACKAGE_NAME } from "@agentic-dev-runner/core";

describe("workspace smoke test", () => {
  it("imports the core workspace package", () => {
    expect(CORE_PACKAGE_NAME).toBe("@agentic-dev-runner/core");
  });
});
