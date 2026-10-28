# First live run

Real OpenCode Go / GLM-5.3-Flash run on 2026-10-27, using production runner build `c2977751a88be1dbffd289d3ddc0ab9c4aca6d37`. Four original acceptance tests passed; runner task DONE, one completed queue entry and clean worktree. CEO held-out probes then found numeric-key ordering and `__proto__` output defects. This is retained as an incomplete implementation, not the final example. Original inputs and generated source are preserved here.

The sandbox copy of the harness differed only by relocating its import to the verified built runner; byte equivalence was asserted after restoring the relative import. No adapter or scheduler was mocked.
