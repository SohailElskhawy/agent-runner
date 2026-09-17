import { describe, expect, it } from "vitest";
import {
  orderRunnableTasks,
  type Task,
} from "@agentic-dev-runner/core";

function makeTask(overrides?: {
  id?: string;
  priority?: Task["priority"];
  status?: Task["status"];
}): Task {
  return {
    id: overrides?.id ?? "M001",
    projectId: "proj-1",
    title: "Add a small utility function",
    milestone: "milestone-1",
    status: overrides?.status ?? "READY",
    type: "implementation",
    priority: overrides?.priority ?? "P1",
    risk: "low",
    definition: {
      objective: "Add one validated utility function.",
      acceptanceCriteria: ["Valid input returns expected output."],
      scope: {
        allowedPaths: ["src/utils/**"],
        forbiddenPaths: ["docs/**"],
      },
      resources: ["utils"],
      verification: { required: ["typecheck", "unit"] },
      limits: { maxAttempts: 3, maxReviewCycles: 2 },
      approval: { required: false },
    },
    routing: {
      complexity: "small",
      capabilities: ["typescript"],
    },
    provenance: { kind: "user_request", source: "manual" },
    dependsOn: [],
    workflow: "default",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("orderRunnableTasks", () => {
  it("orders higher priorities before lower priorities", () => {
    const p2 = makeTask({ id: "M003", priority: "P2" });
    const p1 = makeTask({ id: "M002", priority: "P1" });
    const p0 = makeTask({ id: "M001", priority: "P0" });

    const ordered = orderRunnableTasks([p2, p1, p0]);

    expect(ordered.map((task) => task.id)).toEqual(["M001", "M002", "M003"]);
  });

  it("orders tasks with the same priority deterministically by task id", () => {
    const late = makeTask({ id: "M010", priority: "P1" });
    const early = makeTask({ id: "M002", priority: "P1" });
    const middle = makeTask({ id: "M007", priority: "P1" });

    const ordered = orderRunnableTasks([late, early, middle]);

    expect(ordered.map((task) => task.id)).toEqual(["M002", "M007", "M010"]);
  });

  it("produces the same ordering regardless of the input order", () => {
    const tasks = [
      makeTask({ id: "M009", priority: "P2" }),
      makeTask({ id: "M001", priority: "P0" }),
      makeTask({ id: "M004", priority: "P1" }),
      makeTask({ id: "M002", priority: "P0" }),
      makeTask({ id: "M006", priority: "P1" }),
    ];
    const reversed = [...tasks].reverse();
    const shuffled = [tasks[2]!, tasks[0]!, tasks[4]!, tasks[1]!, tasks[3]!];

    const fromTasks = orderRunnableTasks(tasks);
    const fromReversed = orderRunnableTasks(reversed);
    const fromShuffled = orderRunnableTasks(shuffled);

    expect(fromReversed).toEqual(fromTasks);
    expect(fromShuffled).toEqual(fromTasks);
    expect(fromTasks.map((task) => task.id)).toEqual([
      "M001",
      "M002",
      "M004",
      "M006",
      "M009",
    ]);
  });

  it("orders an empty input to an empty output", () => {
    expect(orderRunnableTasks([])).toEqual([]);
  });

  it("orders a single task to itself", () => {
    const task = makeTask({ id: "M001", priority: "P3" });

    expect(orderRunnableTasks([task])).toEqual([task]);
  });

  it("produces identical results for repeated invocations", () => {
    const tasks = [
      makeTask({ id: "M005", priority: "P1" }),
      makeTask({ id: "M001", priority: "P0" }),
      makeTask({ id: "M003", priority: "P1" }),
    ];

    expect(orderRunnableTasks(tasks)).toEqual(orderRunnableTasks(tasks));
  });

  it("never mutates the input collection or the tasks", () => {
    const first = makeTask({ id: "M002", priority: "P1" });
    const second = makeTask({ id: "M001", priority: "P0" });
    const tasks = [first, second];
    const snapshot = structuredClone(tasks);

    const ordered = orderRunnableTasks(tasks);

    expect(tasks).toEqual(snapshot);
    expect(ordered).not.toBe(tasks);
    expect(ordered[0]).toBe(second);
    second.priority = "P2";
    expect(ordered[0]?.priority).toBe("P2");
  });
});
