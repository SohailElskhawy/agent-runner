# Final real run

2026-10-27, OpenCode Go / `opencode-go/glm-5.3-flash`, production runner build `c2977751a88be1dbffd289d3ddc0ab9c4aca6d37`. Task `JSONL1`: DONE; one COMPLETED queue entry, successful task and integration verification, six immutable acceptance tests pass. Task/integration commit `9cc781dc9322f23e551d9e424e6e0bfc34a24b77`. Git checkout clean; task worktree removed. Seed hashes unchanged and only `src/report.mjs` changed.

The source-checkout build was resource-deferred, so the CEO reused a previously built and fully verified own worktree. Its production source matches this example branch. A sandbox copy of `run.mjs` changed only the import to that build; restoring its relative import was asserted byte-identical. `runCli`, production service composition, adapter, scheduler, Git and verifier were used without fake-agent overrides. Paths in transcripts are replaced with `<sandbox>`, `<checkout>` and `<runner-checkout>`; no runtime DB or credentials are copied.

Reproduce with the ordinary example command after building the source checkout. The fresh full workspace build on this example branch remains an integration gate, not a claimed pass.
