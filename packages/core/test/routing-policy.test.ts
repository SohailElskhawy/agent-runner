import { describe, expect, it } from "vitest";
import { requiredTierFor } from "@agentic-dev-runner/core";

describe("requiredTierFor", () => {
  it("maps task risk and complexity to the minimum tier", () => {
    expect(requiredTierFor({ risk: "low", routing: { complexity: "trivial" } }, 0)).toBe("economy");
    expect(requiredTierFor({ risk: "medium", routing: { complexity: "small" } }, 0)).toBe("standard");
    expect(requiredTierFor({ risk: "low", routing: { complexity: "medium" } }, 0)).toBe("standard");
    expect(requiredTierFor({ risk: "low", routing: { complexity: "large" } }, 0)).toBe("strong");
    expect(requiredTierFor({ risk: "critical", routing: { complexity: "small" } }, 0)).toBe("strong");
  });

  it("escalates once per prior failure and caps at strong", () => {
    const task = { risk: "low" as const, routing: { complexity: "trivial" as const } };
    expect(requiredTierFor(task, 0)).toBe("economy");
    expect(requiredTierFor(task, 1)).toBe("standard");
    expect(requiredTierFor(task, 2)).toBe("strong");
    expect(requiredTierFor(task, 9)).toBe("strong");
  });
});
