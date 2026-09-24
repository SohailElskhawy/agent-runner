# Contributing to Agentic Dev Runner

Thanks for your interest in Agentic Dev Runner. This guide covers the
development environment, the verification commands the project expects, and
the rules that keep the codebase portable across macOS, Linux, and Windows.

Before you start, read:

- [`AGENTS.md`](./AGENTS.md) — repository rules that apply to human and AI contributors.
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — architecture invariants that must be preserved.
- [`docs/ADRS.md`](./docs/ADRS.md) — approved decisions; architecture and ADRs take precedence over convenience.
- [`docs/V0.1_SCOPE.md`](./docs/V0.1_SCOPE.md) — what is in and out of scope for v0.1.

## Requirements

- Node.js >= 24
- Git
- pnpm via Corepack (the repository pins `packageManager: pnpm@12.4.1`)

## Development setup

```bash
corepack enable
pnpm install
```

The repository is a pnpm workspace. The CLI is assembled by bundling
`packages/*` into `packages/agentic-dev-runner/bundle/main.js`; run the bundle
directly while developing:

```bash
node packages/agentic-dev-runner/bundle/main.js --help
```

## Verification commands

Run these from the repository root. A change is only complete when they pass:

```bash
pnpm lint        # ESLint over the whole workspace
pnpm typecheck   # TypeScript checks for every package
pnpm build       # Bundle the CLI (packages/agentic-dev-runner)
pnpm test        # Vitest suites for every package
```

The packaged-CLI smoke test is opt-in because it packs the tarball, installs
it into a temporary directory, and runs a real task end to end:

```bash
AGENTIC_PACK_SMOKE=1 pnpm --filter agentic-dev-runner test
```

On Windows PowerShell:

```powershell
$env:AGENTIC_PACK_SMOKE=1; pnpm --filter agentic-dev-runner test
```

### Live tests (environment-gated)

These suites are skipped by default and require the corresponding agent CLI
installed, on `PATH`, and authenticated:

| Variable | What it runs |
| --- | --- |
| `AGENTIC_OPENCODE_LIVE_E2E=1` | The full vertical slice against a real OpenCode agent |
| `AGENTIC_OPENCODE_SMOKE=1` | The OpenCode adapter smoke test |
| `AGENTIC_CODEX_SMOKE=1` | The Codex adapter smoke test |

They are never run in normal CI; run them locally before changes that touch an
adapter or the execution pipeline.

## Testing policy

The default policy is `TEST_AFTER_IMPLEMENTATION`: implement the change, then
add or update tests that target meaningful behavior (not implementation
details). Use TDD when the task or workflow explicitly requires it. Do not add
tests purely to raise coverage, and do not weaken or delete assertions to make
a suite pass.

## Cross-platform rules

macOS, Linux, and Windows are first-class platforms. Production code must not
assume:

- that Bash is available,
- that `/tmp` exists,
- that `/` is the path separator,
- that Unix signals behave the same on Windows,
- that shell quoting is portable,
- that symlinks or executable permission bits exist.

Prefer direct child-process invocation with argument arrays over shell command
strings, and use Node’s `path`/`os` APIs instead of constructing filesystem
paths by hand. Platform-specific behavior belongs behind the platform
abstractions. If a fix only works on one OS, it is not finished.

## Pull request checklist

- [ ] The change is scoped to one task and does not include unrelated refactors.
- [ ] Architecture invariants and ADRs are preserved (or the change is escalated for approval).
- [ ] New behavior is covered by tests at the appropriate level.
- [ ] Documentation (`README.md`, `docs/`) is updated when user-visible behavior changes.
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm test` are green locally.
- [ ] Cross-platform implications are considered; no new Bash/`/tmp`/shell-string assumptions.
- [ ] No secrets, credentials, or private environment values are added to code, fixtures, logs, or configuration.
- [ ] Commit messages are conventional (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, …) and describe one change.

Report verification evidence in the PR description — the exact commands you
ran and their results. “Looks correct” is not verification.
