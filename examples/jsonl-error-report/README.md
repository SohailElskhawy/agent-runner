# JSONL error report (WIP)

**Not yet recorded or verified end to end.** The guarded build could not acquire the machine-wide heavy-job lock before the live-start cutoff. No provider invocation has been made; the harness and final implementation still require a real run and review. See [run notes](runs/opencode-2026-10-27/README.md).

This example runs a bounded manual task against a small Node.js service-log report. It uses the real OpenCode adapter and `opencode-go/glm-5.3-flash`; it requires an already authenticated OpenCode subscription for that model. There is no paid-provider fallback. The seed has no implementation, so its immutable acceptance tests fail until the task is implemented.

From a source checkout, install dependencies and build first:

```sh
pnpm install --frozen-lockfile
pnpm build
node examples/jsonl-error-report/run.mjs /path/to/new-example-directory
```

Use a **new** target whose parent already exists. The harness refuses an existing target before writing anything. It copies only `seed/` to `target/repo`, initializes branch `autopilot/example-jsonl`, commits the seed, and invokes `init`, `tasks add`, `run --parallel 1`, `status`, and `inspect JSONL1` through `runCli`. It uses the production service factory and adapter, scheduler, Git and verification machinery; no agent is substituted. The explicit `target/state` keeps the SQLite database and worktrees under the target instead of the CLI's default user state directory. The task has one attempt and a 120-second agent timeout. A nonzero harness exit or a task other than `DONE` with exactly one completed integration queue entry is not success. Inspect the output on failures; the target is retained for investigation.

The report reads JSONL on standard input and prints compact JSON counts of `error` events by service in sorted order. After a successful run:

```sh
cd /path/to/new-example-directory/repo
node --test test/report.test.mjs
node src/report.cjs < data/service.jsonl
```

`runs/opencode-2026-10-27/` records the actual run and its limitations. `output/`, when present, contains only the resulting source, tests, and example input/output; no runtime database or credentials are included.
