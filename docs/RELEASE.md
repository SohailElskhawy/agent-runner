# Release Checklist and Procedure

This document defines the release checklist, exact commands, evidence gates, and rollback procedures for `agentic-dev-runner` v0.1.0 and subsequent releases.

> **Important**: Publishing to npm, pushing Git tags, and creating GitHub releases are external actions with irreversible side effects. They must **never** be performed autonomously by an agent without explicit human approval at execution time.

---

## Pre-Release Verification Gates

Before publishing or tagging, all of the following evidence gates must be verified:

### 1. CI Green on All Platforms
Verify that the release commit passes CI on all three supported operating systems:
- Linux (`ubuntu-latest`)
- macOS (`macos-latest`)
- Windows (`windows-latest`)

Command:
```bash
gh run list --commit $(git rev-parse HEAD)
```
**Evidence gate:** All workflow jobs across Linux, macOS, and Windows (lint, typecheck, unit, integration, and e2e suites) report green/success.

---

### 2. Local Pack Smoke Test
Run the packed CLI smoke test suite in an isolated fixture environment:
```bash
AGENTIC_PACK_SMOKE=1 pnpm test
```
On Windows PowerShell:
```powershell
$env:AGENTIC_PACK_SMOKE = "1"; pnpm --filter agentic-dev-runner test
```
**Evidence gate:** `test/pack-smoke.test.ts` passes. This test creates a tarball with `pnpm pack`, installs it in a separate consumer package, and executes an end-to-end task run verifying status `1 DONE` and atomic git commit creation.

---

### 3. Dogfood Verification
Verify that `docs/DOGFOOD.md` contains the 20-task roadmap execution specification and transcript notes.
To execute the automated 20-task DAG suite locally:
```bash
pnpm test packages/cli/test/roadmap-20-tasks-e2e.test.ts
```
**Evidence gate:** All 20 tasks reach status `DONE`, serialized integration queue completes 20 atomic task commits, and mutual exclusion / worktree isolation hold.

---

### 4. Version Check
Verify the version in `packages/agentic-dev-runner/package.json` is `0.1.0`:
```bash
node -e "const pkg = JSON.parse(require('fs').readFileSync('packages/agentic-dev-runner/package.json','utf8')); console.log(pkg.version); if (pkg.version !== '0.1.0') process.exit(1);"
```
**Evidence gate:** Version string is strictly `0.1.0`.

---

### 5. Build Distribution Bundle
Rebuild the standalone distribution bundle:
```bash
pnpm --filter agentic-dev-runner bundle
```
Verify the bundled CLI reports the correct version:
```bash
node packages/agentic-dev-runner/bundle/main.js version
```
**Evidence gate:** Outputs `agentic 0.1.0`.

---

### 6. Package Tarball Inspection
Pack the distribution package and inspect the tarball contents and dependencies:
```bash
pnpm --filter agentic-dev-runner pack --pack-destination .
tar -tzf agentic-dev-runner-0.1.0.tgz
```
Clean up the test archive after verification:
```bash
rm agentic-dev-runner-0.1.0.tgz
```
**Evidence gates:**
- Archive contains strictly:
  - `package/bundle/main.js`
  - `package/README.md`
  - `package/LICENSE`
  - `package/THIRD-PARTY-NOTICES.md`
  - `package/package.json`
- `package.json` inside the archive has no runtime `dependencies` field (zero-dependency bundled artifact).

---

## Release Execution (Requires Explicit Human Authorization)

> **Warning:** Only proceed with the steps below when explicitly authorized by the user.

### 7. Publish to npm
Publish the public package from `packages/agentic-dev-runner`:
```bash
pnpm --filter agentic-dev-runner publish --access public --no-git-checks
```
**Evidence gate:** npm registry accepts the package and `npm view agentic-dev-runner@0.1.0` confirms availability.

---

### 8. Post-Publish Smoke Test in a Clean Directory
Verify the published package in a fresh temporary directory outside the repository:

**macOS / Linux:**
```bash
TMP_DIR=$(mktemp -d)
cd "$TMP_DIR"
npx agentic-dev-runner@0.1.0 version
git init .
npx agentic-dev-runner@0.1.0 doctor
cd -
rm -rf "$TMP_DIR"
```

**Windows (PowerShell):**
```powershell
$tmpDir = Join-Path $env:TEMP ([System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $tmpDir | Out-Null
Push-Location $tmpDir
npx agentic-dev-runner@0.1.0 version
git init .
npx agentic-dev-runner@0.1.0 doctor
Pop-Location
Remove-Item -Recurse -Force $tmpDir
```
**Evidence gates:**
- `npx agentic-dev-runner@0.1.0 version` outputs `agentic 0.1.0`.
- `npx agentic-dev-runner@0.1.0 doctor` completes preflight health checks without error.

---

### 9. Tag and GitHub Release
Create and push the release Git tag, then create the GitHub release:
```bash
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin master --tags
gh release create v0.1.0 --title "v0.1.0" --notes-file CHANGELOG.md
```
**Evidence gate:** Tag `v0.1.0` is published on GitHub with the release notes from `CHANGELOG.md`.

---

## Rollback & Deprecation Procedure

1. **npm Unpublish Policy:**
   npm unpublish is restricted to packages published within 72 hours and without dependents. Unpublishing can break builds for early adopters. Avoid unpublishing unless credentials or security-critical data were leaked.

2. **Emergency Patch and Deprecation:**
   If a critical defect is identified in `0.1.0`:
   1. Fix the issue on a hotfix branch.
   2. Bump version to `0.1.1` in `packages/agentic-dev-runner/package.json`.
   3. Run all pre-release verification gates (1 through 6).
   4. Publish `0.1.1`:
      ```bash
      pnpm --filter agentic-dev-runner publish --access public --no-git-checks
      ```
   5. Deprecate `0.1.0` on npm with an informative notice:
      ```bash
      npm deprecate agentic-dev-runner@0.1.0 "broken release; use 0.1.1"
      ```
   6. Tag `v0.1.1` and publish updated GitHub release notes.
