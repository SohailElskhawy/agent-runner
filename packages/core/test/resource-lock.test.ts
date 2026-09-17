import { describe, expect, it } from "vitest";
import {
  planResourceAcquisition,
  requiredResourceLocks,
  resourceLocksOwnedBy,
  type ResourceLock,
} from "../src/index.js";

const owner = (taskId: string, attemptId?: string) => ({
  taskId,
  ...(attemptId === undefined ? {} : { attemptId }),
});

const lock = (
  resource: string,
  taskId: string,
  attemptId?: string,
): ResourceLock => ({
  resource,
  taskId,
  ...(attemptId === undefined ? {} : { attemptId }),
});

describe("resource locks (M045a)", () => {
  it("plans no locks for a task that declares no resources", () => {
    const plan = planResourceAcquisition(owner("M001", "att_M001_1"), [], []);
    expect(plan).toEqual({ ok: true, locks: [] });
  });

  it("plans one lock for a single required resource", () => {
    const plan = planResourceAcquisition(
      owner("M001", "att_M001_1"),
      ["database-schema"],
      [],
    );
    expect(plan).toEqual({
      ok: true,
      locks: [
        {
          resource: "database-schema",
          taskId: "M001",
          attemptId: "att_M001_1",
        },
      ],
    });
  });

  it("plans every required lock atomically, ordered ascending regardless of declaration order", () => {
    const first = planResourceAcquisition(
      owner("M001"),
      ["payments", "auth-state", "routing"],
      [],
    );
    const second = planResourceAcquisition(
      owner("M001"),
      ["routing", "payments", "auth-state"],
      [],
    );
    expect(first).toEqual({
      ok: true,
      locks: [
        { resource: "auth-state", taskId: "M001" },
        { resource: "payments", taskId: "M001" },
        { resource: "routing", taskId: "M001" },
      ],
    });
    expect(second).toEqual(first);
  });

  it("collapses duplicate declared resources into a single lock deterministically", () => {
    const locks = requiredResourceLocks(owner("M001"), [
      "database-schema",
      "database-schema",
      "database-schema",
    ]);
    expect(locks).toEqual([{ resource: "database-schema", taskId: "M001" }]);
    const plan = planResourceAcquisition(
      owner("M001", "att_M001_1"),
      ["auth-state", "auth-state"],
      [],
    );
    expect(plan).toEqual({
      ok: true,
      locks: [{ resource: "auth-state", taskId: "M001", attemptId: "att_M001_1" }],
    });
  });

  it("fails the whole plan when one of several required resources is held by another task", () => {
    const held: readonly ResourceLock[] = [
      lock("payments", "M009", "att_M009_1"),
    ];
    const plan = planResourceAcquisition(
      owner("M001", "att_M001_1"),
      ["auth-state", "payments", "routing"],
      held,
    );
    expect(plan).toEqual({
      ok: false,
      conflicts: [
        {
          resource: "payments",
          holderTaskId: "M009",
          holderAttemptId: "att_M009_1",
        },
      ],
    });
    expect(plan.ok === false && plan.conflicts.length === 1).toBe(true);
  });

  it("acquires none of the required locks when acquisition is rejected", () => {
    const held: readonly ResourceLock[] = [lock("routing", "M009")];
    const plan = planResourceAcquisition(
      owner("M001", "att_M001_1"),
      ["auth-state", "routing", "payments"],
      held,
    );
    if (plan.ok) {
      throw new Error("expected the plan to fail");
    }
    expect(plan.conflicts.map((conflict) => conflict.resource)).toEqual([
      "routing",
    ]);
  });

  it("reports every conflicting holder deterministically when several required resources are held", () => {
    const held: readonly ResourceLock[] = [
      lock("routing", "M010"),
      lock("payments", "M009"),
      lock("auth-state", "M008"),
      lock("unrelated", "M011"),
    ];
    const plan = planResourceAcquisition(
      owner("M001", "att_M001_1"),
      ["payments", "auth-state", "routing"],
      held,
    );
    if (plan.ok) {
      throw new Error("expected the plan to fail");
    }
    expect(plan.conflicts).toEqual([
      { resource: "auth-state", holderTaskId: "M008" },
      { resource: "payments", holderTaskId: "M009" },
      { resource: "routing", holderTaskId: "M010" },
    ]);
  });

  it("a second task cannot plan a resource already held by the first", () => {
    const held: readonly ResourceLock[] = [
      lock("database-schema", "M001", "att_M001_1"),
    ];
    const first = planResourceAcquisition(
      owner("M001", "att_M001_1"),
      ["database-schema"],
      held,
    );
    expect(first).toEqual({
      ok: true,
      locks: [{ resource: "database-schema", taskId: "M001", attemptId: "att_M001_1" }],
    });
    const second = planResourceAcquisition(
      owner("M002", "att_M002_1"),
      ["database-schema"],
      held,
    );
    expect(second).toEqual({
      ok: false,
      conflicts: [
        {
          resource: "database-schema",
          holderTaskId: "M001",
          holderAttemptId: "att_M001_1",
        },
      ],
    });
  });

  it("treats a different attempt of the same task as a different owner, deterministically", () => {
    const held: readonly ResourceLock[] = [
      lock("database-schema", "M001", "att_M001_1"),
    ];
    const plan = planResourceAcquisition(
      owner("M001", "att_M001_2"),
      ["database-schema"],
      held,
    );
    expect(plan).toEqual({
      ok: false,
      conflicts: [
        {
          resource: "database-schema",
          holderTaskId: "M001",
          holderAttemptId: "att_M001_1",
        },
      ],
    });
  });

  it("re-acquiring an already-owned resource is idempotent and creates no duplicate holder", () => {
    const held: readonly ResourceLock[] = [
      {
        resource: "database-schema",
        taskId: "M001",
        attemptId: "att_M001_1",
        acquiredAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const plan = planResourceAcquisition(
      owner("M001", "att_M001_1"),
      ["database-schema", "auth-state"],
      held,
    );
    expect(plan).toEqual({
      ok: true,
      locks: [
        { resource: "auth-state", taskId: "M001", attemptId: "att_M001_1" },
        { resource: "database-schema", taskId: "M001", attemptId: "att_M001_1" },
      ],
    });
  });

  it("unrelated resources can coexist across tasks without conflicts", () => {
    const held: readonly ResourceLock[] = [
      lock("auth-state", "M001", "att_M001_1"),
      lock("payments", "M002", "att_M002_1"),
    ];
    const plan = planResourceAcquisition(
      owner("M003", "att_M003_1"),
      ["routing", "package-lock"],
      held,
    );
    expect(plan).toEqual({
      ok: true,
      locks: [
        { resource: "package-lock", taskId: "M003", attemptId: "att_M003_1" },
        { resource: "routing", taskId: "M003", attemptId: "att_M003_1" },
      ],
    });
  });

  it("selects exactly the locks owned by an attempt for release, deterministically", () => {
    const held: readonly ResourceLock[] = [
      lock("routing", "M001", "att_M001_1"),
      lock("payments", "M001", "att_M001_2"),
      {
        resource: "auth-state",
        taskId: "M001",
        attemptId: "att_M001_1",
        acquiredAt: "2026-01-01T00:00:00.000Z",
      },
      lock("database-schema", "M002", "att_M002_1"),
    ];
    const owned = resourceLocksOwnedBy(held, owner("M001", "att_M001_1"));
    expect(owned.map((lock_) => lock_.resource)).toEqual([
      "auth-state",
      "routing",
    ]);
    const taskOwned = resourceLocksOwnedBy(held, owner("M001"));
    expect(taskOwned).toEqual([]);
  });

  it("produces identical results regardless of input ordering", () => {
    const held = [lock("b", "M002"), lock("a", "M003")];
    const forward = planResourceAcquisition(owner("M001"), ["b", "a"], held);
    const reversed = planResourceAcquisition(owner("M001"), ["a", "b"], [
      ...held,
    ].reverse());
    expect(reversed).toEqual(forward);
  });

  it("never mutates the declared resources or the held locks", () => {
    const resources = ["routing", "auth-state"];
    const held: readonly ResourceLock[] = [lock("payments", "M009")];
    const heldCopy = [...held];
    planResourceAcquisition(owner("M001"), resources, held);
    expect(resources).toEqual(["routing", "auth-state"]);
    expect(held).toEqual(heldCopy);
    const duplicateDeclaration = ["database-schema", "database-schema"];
    requiredResourceLocks(owner("M001"), duplicateDeclaration);
    expect(duplicateDeclaration).toEqual([
      "database-schema",
      "database-schema",
    ]);
  });
});
