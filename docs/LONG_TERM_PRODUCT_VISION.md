# Agentic Dev Runner — Long-Term Product Vision

## Vision

Agentic Dev Runner should evolve beyond a coding-agent orchestrator.

The long-term goal is:

> A persistent senior software engineer for the full software-development lifecycle — one that can understand a project, guide decisions, plan work, delegate implementation, verify evidence, protect architecture, manage releases, diagnose failures, and continuously maintain the software.

The product should not merely make agents write code.

It should manage software engineering work.

---

# Product Identity

Agentic Dev Runner should become an AI software-engineering operating system.

Its role is to coordinate and govern engineering work across the full lifecycle:

```text
IDEA
 ↓
DISCOVERY
 ↓
SPECIFICATION
 ↓
ARCHITECTURE
 ↓
ROADMAP
 ↓
TASKS
 ↓
IMPLEMENTATION
 ↓
REVIEW
 ↓
VERIFICATION
 ↓
RELEASE
 ↓
OPERATIONS
 ↓
MAINTENANCE
 ↓
LEARNING
 └──────────────────────→ next iteration
```

The product should eventually understand and participate intelligently at every stage.

It should not blindly automate every decision.

Senior-engineer behavior sometimes means:

- asking for missing context
- rejecting unclear requirements
- identifying architecture violations
- recommending that a feature be deferred
- escalating high-risk work
- preventing unsafe parallelism
- requesting human approval
- choosing a stronger model when a cheaper one repeatedly fails
- refusing to treat agent claims as proof
- identifying missing verification
- protecting scope

The product should therefore optimize for:

1. correctness
2. reliability
3. reviewability
4. recoverability
5. developer control
6. cost efficiency
7. autonomy

Autonomy is important, but never at the cost of engineering discipline.

---

# Full SDLC Capability Map

| SDLC Area | Future Agentic Dev Runner Capability |
|---|---|
| Idea | Assess feasibility, expected complexity, dependencies, risks, unknowns, and likely engineering scope |
| Discovery | Interview the developer/product owner and identify missing decisions, contradictions, assumptions, and unclear requirements |
| Specification | Produce requirements, acceptance criteria, non-functional requirements, constraints, and explicit out-of-scope boundaries |
| Architecture | Propose designs, compare alternatives, produce ADRs, API contracts, schemas, threat models, and architecture boundaries |
| Planning | Produce milestones, vertical slices, bounded mini-tasks, dependency DAGs, risk levels, routing hints, and cost classifications |
| Implementation | Route each task to the cheapest capable agent, isolate work, monitor execution, recover failures, and enforce scope |
| Review | Perform independent code, architecture, security, API, performance, and scope reviews |
| Verification | Run tests, typecheck, lint, builds, E2E, security scans, performance checks, and acceptance verification |
| Release | Assess release readiness, produce release notes, identify migrations, version changes, rollback plans, and deployment checklists |
| Operations | Investigate CI failures, runtime errors, incidents, regressions, telemetry, and production problems |
| Maintenance | Upgrade dependencies, reduce debt, remove dead code, stabilize tests, refactor safely, and preserve architecture |
| Learning | Improve routing and cost decisions based on observed outcomes while preserving explicit policy and deterministic safeguards |

---

# 1. Project Brain

## Goal

Create a persistent engineering knowledge model for the project.

Agents should be disposable.

The project knowledge should not be.

The Project Brain should contain structured knowledge such as:

```text
Project
├── goals
├── requirements
├── constraints
├── decisions
│   ├── ADRs
│   ├── product decisions
│   └── architectural decisions
├── architecture
│   ├── modules
│   ├── dependencies
│   ├── APIs
│   ├── data models
│   └── ownership boundaries
├── milestones
├── tasks
├── commits
├── releases
├── incidents
├── verification history
└── technical debt
```

## Key Principle

Do not treat the Project Brain as merely an embedding index.

It should preserve structured, inspectable knowledge.

The system should know:

- what the project is trying to achieve
- what decisions have been made
- why those decisions were made
- what architecture must be preserved
- what requirements are implemented
- what requirements remain incomplete
- what code satisfies which requirement
- which tasks have failed before
- what verification has already been performed
- what technical debt is known
- what releases introduced which behavior

## Possible CLI

```bash
agentic ask "Why do we use SQLite?"

agentic ask "What depends on authentication?"

agentic ask "Which requirements are still incomplete?"

agentic ask "What changed in the billing architecture since v0.3?"

agentic ask "Which tasks failed previously because of scope violations?"
```

## Why This Matters

Every future model can be treated as a replaceable worker.

Codex, Claude, OpenCode, Antigravity, local models, and future agents may change.

The project memory remains.

---

# 2. Requirement-to-Evidence Traceability

## Goal

Maintain a complete engineering evidence chain.

```text
Requirement
   ↓
Design decision
   ↓
Milestone
   ↓
Task
   ↓
Implementation commit
   ↓
Tests
   ↓
Verification evidence
   ↓
Release
```

## Example

```bash
agentic trace AUTH-07
```

Possible result:

```text
AUTH-07
"Session expires after 30 days"

Implemented by:
  T084 — Add session expiry validation

Commit:
  94be17a

Verified by:
  auth-session.test.ts
  auth-e2e.spec.ts

Released:
  v1.4.0
```

## Future Uses

This creates strong support for:

- regulated environments
- compliance evidence
- enterprise engineering
- release audits
- incident investigation
- requirement coverage
- change-impact analysis
- regression analysis

The system should be able to answer:

> "What proves this requirement is implemented?"

---

# 3. Architecture Guardian

## Goal

Continuously protect architectural boundaries.

Agent Runner should understand architecture rules such as:

```text
frontend must not import persistence

core must not depend on provider adapters

domain cannot directly access SQLite

billing cannot depend directly on UI

provider-specific behavior must remain inside adapters
```

## During Task Execution

Before integration, the runner should check:

- changed modules
- dependency direction
- public interfaces
- forbidden imports
- architecture ownership
- ADR constraints

Example:

```text
Task M231

Agent modified:
  packages/core/src/foo.ts
  packages/persistence/src/bar.ts

Architecture violation:
  core → persistence dependency introduced

Task BLOCKED
```

## Possible CLI

```bash
agentic architecture check
```

Example:

```text
3 violations
2 warnings
0 undocumented module dependencies
```

And:

```bash
agentic architecture drift
```

Possible result:

```text
The implementation has gradually diverged from ADR-012
across 17 commits.

Affected modules:
- billing
- checkout
- persistence
```

## Long-Term Value

This makes Agent Runner act more like a senior/staff engineer than a code-generation tool.

---

# 4. Engineering Workflows by Work Type

Agent Runner should eventually understand the type of engineering work being performed.

Possible workflows:

```bash
agentic feature
agentic bug
agentic refactor
agentic migrate
agentic upgrade
agentic security
agentic incident
agentic release
agentic prototype
```

Each workflow should have a different lifecycle.

## Feature Workflow

```text
clarify
→ specify
→ design
→ decompose
→ implement
→ review
→ acceptance verify
→ integrate
```

## Bug Workflow

```text
reproduce
→ isolate root cause
→ create regression test
→ implement smallest fix
→ verify regression
→ review side effects
→ integrate
```

## Refactor Workflow

```text
establish behavioral baseline
→ identify safe seams
→ incremental transformation
→ prove behavior unchanged
→ review architecture impact
→ integrate
```

## Dependency Upgrade Workflow

```text
analyze breaking changes
→ identify affected code
→ create migration plan
→ update dependency
→ migrate
→ verify
→ review
```

## Security Workflow

```text
identify vulnerability
→ assess impact
→ isolate affected surface
→ implement remediation
→ run security verification
→ review
→ require approval where appropriate
```

## Incident Workflow

```text
collect evidence
→ identify likely causes
→ mitigate
→ patch
→ verify
→ release
→ produce postmortem
```

## Prototype Workflow

```text
clarify experiment
→ define success criteria
→ build minimal prototype
→ evaluate
→ record learnings
→ stop / promote / discard
```

The workflow engine should remain bounded and runner-controlled.

---

# 5. Senior Engineer Review

## Goal

Move beyond simple code review.

A review should evaluate multiple engineering dimensions.

Example:

```text
IMPLEMENTATION REVIEW

Acceptance criteria        PASS
Tests                      PASS
Scope                      PASS
Architecture               PASS
Security                   PASS
Error handling             WARNING
API compatibility          PASS
Performance impact         UNKNOWN

Finding:
New retry loop has no jitter.

Decision:
FIX_REQUIRED
```

## Review Types

Future review stages may include:

- code correctness review
- architecture review
- security review
- API compatibility review
- migration review
- performance review
- test-quality review
- scope review
- maintainability review
- accessibility review
- data/privacy review

## Independent Reviewer Principle

Where practical:

```text
implementation model
        ≠
review model
```

Example:

```text
cheap model → implementation
strong model → review
runner → verification
runner → integration
```

This is preferable to repeatedly asking an agent to approve its own work.

---

# 6. Automatic Task Splitting During Execution

## Goal

Allow agents to discover that work is larger than initially expected without silently expanding scope.

Example original task:

```text
Add OAuth support.
```

During planning, the system discovers:

```text
database migration
OAuth provider integration
callback endpoint
session changes
UI button
E2E coverage
```

The correct response is not to silently modify everything.

The runner should produce:

```text
TASK_TOO_LARGE

Proposed split:

M041a — Add OAuth account schema
M041b — Implement OAuth callback
M041c — Integrate session creation
M041d — Add login UI
M041e — Add OAuth E2E coverage
```

Then:

- validate provenance
- build dependencies
- validate resource conflicts
- request approval when required
- continue only inside the approved roadmap

This gives autonomy without uncontrolled scope growth.

---

# 7. Cost-Aware Engineering

## Product Principle

The goal is not:

> Which provider should execute this task?

The better question is:

> What is the cheapest capable worker that can safely complete this task?

## Example Routing

```text
trivial / low-risk
      ↓
cheap model

small / low-risk
      ↓
cheap model

medium
      ↓
standard model

high-risk / complex
      ↓
strong model

cheap model fails verification repeatedly
      ↓
escalate model

code review
      ↓
optionally stronger or different model

verification
      ↓
runner-controlled checks

integration
      ↓
runner-controlled Git workflow
```

## Possible CLI

```bash
agentic run   --budget 20   --strategy cost-efficient
```

## Possible Configuration

```yaml
routing:
  strategy: cost-efficient

  trivial:
    max_cost: 0.05

  small:
    max_cost: 0.20

  medium:
    max_cost: 1.00

  escalation:
    attempts_before_upgrade: 2
```

## Example Completion Report

```text
Roadmap completed

38 tasks

31 handled by cheap models
5 escalated
2 required strong model initially

Total model cost: $8.42

Estimated strong-model-only cost: $31.70

Verification failures caught: 7
```

## Product Positioning

The compelling metric is not:

> "We support many providers."

It is:

> "Agent Runner completed the roadmap using expensive intelligence only where it was necessary."

---

# 8. Explainable Routing and Scheduling

The system should always be able to explain its operational decisions.

Possible commands:

```bash
agentic why M042
```

Example:

```text
M042 is not runnable.

Reason:
M038 is not DONE.

Additional constraints:
resource "database-schema" is currently locked.
```

Another example:

```text
M051 routed to Codex.

Reason:
- complexity: medium
- risk: medium
- required capability: TypeScript debugging
- economy model failed verification twice
- escalation threshold reached
```

Possible dry-run workflow:

```bash
agentic run --dry-run
```

Output:

```text
Projected execution:

Layer 1
  M001 → economy
  M002 → economy
  M003 → standard

Layer 2
  M004 → economy
  M005 → blocked by M003

Maximum safe parallelism: 3

Estimated model cost: $2.10–$4.80
```

The scheduler should never feel mysterious.

---

# 9. Autonomous Technical Debt Management

## Project Health

Possible command:

```bash
agentic health
```

Example:

```text
Project health

Architecture drift       LOW
Outdated dependencies    6
Known flaky tests        2
TODO/FIXME debt          18
Large modules            3
Uncovered critical code  1
Dead code candidates     7
Security advisories      0
```

## Improvement Planning

Possible command:

```bash
agentic improve
```

The runner should not immediately modify the repository.

Instead:

```text
Proposed maintenance roadmap

M301 Remove deprecated API adapter
M302 Split oversized auth service
M303 Upgrade Zod
M304 Stabilize checkout E2E

Approve? [Y/n]
```

## Product Principle

Maintenance follows the same safe model:

```text
discover
→ propose
→ approve
→ execute
```

---

# 10. Continuous Repository Steward

## Goal

Eventually allow Agent Runner to continuously monitor the health of a repository.

Possible event:

```text
Git push
   ↓
Agent Runner evaluates change
   ↓
architecture check
security check
test impact analysis
spec consistency
```

Possible security flow:

```text
Dependency vulnerability appears
       ↓
runner identifies affected project
       ↓
creates bounded remediation proposal
       ↓
human approves
       ↓
runner patches
       ↓
verifies
       ↓
integrates
```

Possible CI flow:

```text
CI fails on main
       ↓
runner investigates
       ↓
identifies likely root cause
       ↓
proposes bounded task
       ↓
human approves
       ↓
runner fixes + verifies
```

At this point Agent Runner becomes more than a development agent.

It becomes a repository steward.

---

# 11. Release Engineer

## Goal

Make release preparation an engineering workflow owned by the runner.

Possible command:

```bash
agentic release
```

The system could evaluate:

```text
all roadmap items complete?
all required verification green?
unresolved blockers?
breaking APIs?
database migrations?
security-critical changes?
version recommendation?
release notes?
rollback strategy?
deployment prerequisites?
```

Example:

```text
RELEASE READINESS

Version: 1.7.0

Tasks completed: 24/24
Required verification: PASS
Breaking changes: none
Database migrations: 1
Manual approval required: YES
Rollback available: YES

Release?
```

## Future Capabilities

Subject to explicit policy and approval:

- version recommendation
- changelog generation
- release notes
- migration summary
- rollback checklist
- Git tags
- GitHub releases
- deployment preparation
- deployment verification
- post-release checks

---

# 12. Production Feedback Loop

## Long-Term Goal

Close the complete SDLC loop.

```text
production exception
        ↓
correlate to release
        ↓
locate suspected commit
        ↓
reproduce
        ↓
create bounded bug task
        ↓
fix in isolated worktree
        ↓
regression test
        ↓
review
        ↓
human approval
        ↓
release
```

Full lifecycle:

```text
idea
→ build
→ release
→ observe
→ diagnose
→ improve
→ release
```

Potential future integrations:

- CI systems
- error monitoring
- tracing systems
- metrics
- issue trackers
- Git hosting
- deployment systems

Agent Runner should coordinate these systems rather than replace them.

---

# 13. Impact Analysis

Before a task executes, Agent Runner should estimate what the change may affect.

Example:

```bash
agentic impact T084
```

Possible result:

```text
Task:
T084 — Change session expiry behavior

Potential impact:

Direct:
- auth/session.ts
- auth/session.test.ts

API:
- POST /login
- GET /session

Consumers:
- web-app
- admin-console

Persistence:
- no schema change

Risk:
medium

Recommended verification:
- auth unit tests
- auth integration tests
- session E2E
```

This is particularly useful for:

- large repositories
- shared libraries
- APIs
- migrations
- refactors
- high-risk changes

---

# 14. Spec Drift Detection

The code, tests, architecture, and documentation can diverge over time.

Agent Runner should detect drift.

Possible command:

```bash
agentic drift
```

Example:

```text
SPEC DRIFT DETECTED

Requirement:
AUTH-12 requires session revocation on password reset.

Implementation:
No matching behavior detected.

Tests:
No test currently verifies AUTH-12.

Recommendation:
Create remediation task.
```

Or:

```text
ADR DRIFT DETECTED

ADR-009:
Provider-specific behavior must remain behind adapters.

Detected:
packages/orchestrator/src/router.ts
contains provider-specific Codex handling.
```

This turns specifications into living engineering contracts.

---

# 15. Change Review Before Execution

For high-risk changes, Agent Runner could produce a pre-execution engineering brief.

Example:

```text
CHANGE PLAN

Goal:
Introduce multi-tenant organization support.

Affected domains:
- authentication
- authorization
- persistence
- billing
- API contracts

Risks:
HIGH

Database migration:
YES

Breaking API changes:
POSSIBLE

Suggested roadmap:
14 tasks
4 milestones

Human approvals required:
- schema migration
- authorization model
```

This is the equivalent of a senior engineer reviewing the shape of work before implementation begins.

---

# 16. Multi-Role Agent Collaboration

Eventually, Agent Runner should support distinct engineering roles without turning the system into uncontrolled agent conversation.

Possible roles:

```text
planner
architect
implementer
reviewer
security reviewer
test engineer
release engineer
incident investigator
```

Important rule:

These roles do not own orchestration state.

The runner owns the workflow.

Example:

```text
architect
   ↓
architecture proposal

runner
   ↓
approval gate

planner
   ↓
task decomposition

runner
   ↓
validated DAG

implementer
   ↓
code change

reviewer
   ↓
review findings

runner
   ↓
verification + integration
```

Agents remain replaceable workers inside a deterministic workflow.

---

# 17. Model/Agent Capability Profiles

Agent Runner should learn to distinguish workers by capability rather than only provider name.

Example profile:

```text
AgentProfile

provider: opencode
model: economy-x

capabilities:
- typescript
- unit_tests
- documentation
- structured_output

strengths:
- small implementation tasks
- repetitive migrations

limits:
- weak long-context architecture reasoning
```

Another:

```text
provider: claude
model: strong-y

capabilities:
- architecture
- debugging
- security_review
- large_context

cost_class:
high
```

Routing then becomes capability-oriented.

Task says:

```text
requires:
- typescript
- database_migration
- security_review
```

The router selects a compatible worker under the configured cost/risk policy.

---

# 18. Historical Performance and Adaptive Routing

This should come much later.

Once enough execution history exists, Agent Runner can measure:

- success rate by task type
- verification failure rate
- review rejection rate
- retry count
- time to completion
- token usage
- cost
- context size
- provider/model reliability

Then routing can improve.

Example:

```text
For TypeScript bugfix tasks:

Economy-A
success: 91%
avg cost: $0.08

Model-B
success: 96%
avg cost: $0.44

Model-C
success: 98%
avg cost: $1.20
```

The system might still choose Economy-A for low-risk tasks.

However, learned routing must remain bounded by explicit policy.

Risk and capability constraints always override historical optimization.

---

# 19. Developer Control Center

Eventually a GUI may become useful.

But it should sit on top of the same headless engine.

Possible views:

- roadmap graph
- milestone progress
- task DAG
- active tasks
- agent assignments
- model costs
- blocked tasks
- approvals
- architecture violations
- verification evidence
- release readiness
- project health
- task history
- requirement traceability

The GUI must not contain separate orchestration logic.

CLI, GUI, API, and automation should all use the same application/core layer.

---

# 20. Team Mode

Much later, the same system could coordinate humans and agents.

Example task ownership:

```text
T001 → human: Alice
T002 → Codex economy
T003 → Claude
T004 → human approval
T005 → OpenCode
```

Potential capabilities:

- human task assignment
- code ownership awareness
- team approval policies
- review ownership
- escalation rules
- handoff between human and AI engineers
- team-specific routing policy
- project-level permissions

Agent Runner should treat humans and agents as different worker types under one engineering workflow.

---

# 21. Repository Policies as Code

Engineering rules should eventually become machine-checkable.

Example:

```yaml
policies:
  database_migrations:
    approval_required: true
    reviewer: strong

  security_critical:
    parallel: false
    reviewer: independent
    verification:
      - security
      - integration
      - e2e

  public_api:
    compatibility_check: required

  dependency_changes:
    require_lockfile_verification: true
```

Policies may govern:

- approvals
- model class
- review rigor
- required verification
- concurrency
- secrets access
- command execution
- deployment permissions
- release requirements

This allows organizations to encode engineering discipline rather than depend on prompts.

---

# 22. Security and Secrets Guardian

Agent Runner should eventually become responsible for enforcing safe agent execution.

Potential protections:

- environment-variable filtering
- secrets redaction
- secret-file access policy
- command allow/deny rules
- network access policy
- filesystem boundaries
- destructive command approval
- production credential protection
- audit trail
- sandbox integration

Example:

```text
Agent requested:

kubectl delete namespace production

BLOCKED

Reason:
Production destructive operations require explicit human approval.
```

This is essential if Agent Runner is ever expected to perform real hands-free engineering.

---

# 23. Database Migration Intelligence

Migrations deserve a specialized workflow.

Possible process:

```text
schema change
→ migration analysis
→ backwards compatibility analysis
→ data-loss analysis
→ migration generation
→ migration verification
→ rollback strategy
→ human approval
→ execution
```

Possible output:

```text
DATABASE CHANGE REVIEW

Migration:
Add NOT NULL workspace_id to invoices

Risk:
HIGH

Existing rows affected:
YES

Backfill required:
YES

Safe zero-downtime path:
1. add nullable column
2. backfill
3. update application
4. validate data
5. apply NOT NULL constraint

Approval required.
```

This is much closer to senior engineering behavior than naïve schema generation.

---

# 24. API Contract Guardian

Agent Runner should understand API compatibility.

Before integration:

```text
API CHANGE DETECTED

GET /users/:id

Removed field:
avatar_url

Consumers detected:
- web
- mobile
- admin-dashboard

Breaking change:
YES

Integration blocked.
```

Potential checks:

- OpenAPI diff
- GraphQL schema compatibility
- protobuf compatibility
- package public API
- TypeScript exported interfaces
- event schemas

---

# 25. Performance Engineering Workflow

Future workflow:

```text
define performance target
→ create benchmark
→ establish baseline
→ implement optimization
→ compare result
→ detect regressions
→ review maintainability impact
```

Example:

```text
PERFORMANCE RESULT

Endpoint:
/api/search

Baseline p95:
820 ms

New p95:
310 ms

Target:
< 400 ms

Result:
PASS

Memory:
+3%

Regression checks:
PASS
```

---

# 26. Test Strategy Engineer

Agent Runner should eventually understand what kind of verification is appropriate.

Not every task needs E2E.

Not every task can be proven by unit tests.

The system should reason about:

- unit tests
- integration tests
- contract tests
- E2E
- property-based tests
- mutation testing
- fuzzing
- performance tests
- security tests
- manual verification

Example:

```text
Task:
Change currency conversion rounding.

Recommended evidence:

Required:
- unit tests
- property-based tests

Not required:
- E2E

Reason:
Behavior is pure domain logic with no user-flow or infrastructure change.
```

The runner should validate evidence rather than maximize test count.

---

# 27. Incident Commander

For production failures:

```bash
agentic incident
```

Possible process:

```text
collect logs
collect traces
identify affected release
identify suspicious commits
reproduce
rank hypotheses
test hypotheses
mitigate
patch
verify
prepare release
write postmortem
```

The system should maintain a timeline:

```text
14:04 alert triggered
14:07 release v2.4.1 correlated
14:12 suspected commit identified
14:19 reproduction confirmed
14:32 mitigation applied
14:50 patch verified
```

This creates durable operational memory.

---

# 28. Engineering Decision Assistant

When an architectural choice is needed:

```bash
agentic decide "Should we use Redis for background jobs?"
```

It could produce:

```text
DECISION REQUIRED

Context:
- current deployment: single-node
- job volume: low
- SQLite already available
- no cross-process queue requirement

Options:

A. SQLite-backed queue
B. Redis queue

Tradeoffs:
...

Recommendation:
A, unless multi-node execution becomes a requirement.

Create ADR?
```

The important part is not that the AI always chooses correctly.

The important part is that:

- alternatives are explicit
- assumptions are visible
- decisions are persisted
- future work can trace back to the decision

---

# 29. Feature Lifecycle Objects

Instead of only tasks and milestones, future versions could introduce a first-class Feature concept.

Example:

```text
Feature: Team invitations

Goal:
Users can invite teammates by email.

Requirements:
REQ-101
REQ-102
REQ-103

Architecture:
ADR-034

Roadmap:
M100

Tasks:
T201–T212

Release:
v1.8.0

Verification:
PASS

Status:
SHIPPED
```

This gives the runner a higher-level unit of engineering work.

---

# 30. Quality Gates by Risk

Risk should determine engineering rigor.

Example:

```text
LOW
→ implement
→ verify
→ integrate
```

```text
MEDIUM
→ plan
→ implement
→ independent review
→ verify
→ integrate
```

```text
HIGH
→ architecture review
→ human approval
→ plan review
→ implement
→ independent review
→ extended verification
→ integration approval
```

```text
CRITICAL
→ explicit human ownership
→ strongest model class
→ security review
→ migration/release plan
→ manual approval gates
→ exhaustive verification
```

This allows low-risk tasks to remain cheap and fast while high-risk work gets senior-level rigor.

---

# 31. Autonomous Bounded Maintenance

The system may eventually run recurring engineering health checks.

Examples:

```text
weekly dependency analysis

nightly flaky-test detection

monthly architecture drift review

release-time security audit
```

But automatic detection must not imply automatic execution.

The default pattern remains:

```text
detect
→ propose
→ approve
→ execute
```

Policies may later allow selected low-risk maintenance categories to run automatically.

---

# 32. Engineering History as a First-Class Asset

Agent Runner should make engineering history queryable.

Possible questions:

```bash
agentic history "authentication"

agentic history --task M042

agentic history --requirement AUTH-07

agentic history --release v1.4.0
```

The system could explain:

- why a task was created
- who/what executed it
- what model was used
- what failures occurred
- why escalation happened
- what verification passed
- what commit was integrated
- what release contained the change

This turns the development process itself into durable project knowledge.

---

# 33. Local-First, Cloud-Optional Evolution

The product should preserve the current local-first philosophy.

Future architecture may add:

- remote workers
- team dashboards
- shared project state
- cloud scheduler
- remote execution
- hosted observability

But the domain model should not require them.

The local engine should remain usable independently.

Possible future modes:

```text
local
team-local
hybrid
cloud-managed
```

The core orchestration concepts should remain identical.

---

# 34. Provider Ecosystem

Future direct adapters may include:

- Codex
- OpenCode
- Claude Code
- Google Antigravity
- Gemini CLI
- local models
- enterprise internal agents
- future coding-agent runtimes

However provider count should not be the primary metric.

Quality metrics should be:

- completion reliability
- verification pass rate
- retry rate
- review rejection rate
- cost
- speed
- capability coverage
- crash behavior
- cancellation behavior

The adapter layer should make adding a new provider routine and low-risk.

---

# 35. Adapter Conformance Suite

Every provider adapter should pass the same contract tests.

Examples:

- successful invocation
- timeout
- cancellation
- crash
- malformed structured output
- unsupported capability
- scope violation
- no code changes
- verification failure
- context delivery
- output normalization
- retry behavior

This protects the provider-independent architecture.

---

# 36. Engineering Simulation / Dry Run

Before executing a large roadmap:

```bash
agentic simulate
```

Possible output:

```text
Roadmap simulation

Tasks: 47
Milestones: 6

Critical path:
M002 → M008 → M019 → M031 → M044

Maximum safe parallelism:
5

Potential conflict groups:
database-schema
auth-state
package-lock

Approval-gated tasks:
4

Estimated cost:
$11–$24

Estimated agent invocations:
68–92

High-risk tasks:
3
```

This helps developers understand the plan before spending money or modifying code.

---

# 37. Project Replay

Because state and events are durable, a future feature could replay execution.

```bash
agentic replay M042
```

Example:

```text
09:12 task became READY
09:13 routed to economy model
09:13 attempt 1 started
09:20 verification failed
09:21 fix cycle started
09:27 verification failed
09:28 escalation to strong model
09:39 implementation passed
09:42 review passed
09:45 integration completed
09:45 task DONE
```

This is useful for debugging the orchestration system itself.

---

# 38. Trust Levels / Autonomy Modes

Different projects need different autonomy.

Possible modes:

```text
MANUAL
GUARDED
AUTONOMOUS
```

## Manual

Every important transition requires approval.

## Guarded

Low-risk routine work runs automatically; risky work requires approval.

## Autonomous

Approved roadmap executes hands-free within configured limits.

Policies should still cap:

- cost
- retries
- scope
- commands
- approvals
- provider classes
- concurrency

Autonomous must never mean unbounded.

---

# 39. Engineering Contracts

The runner should treat several artifacts as contracts:

- specifications
- ADRs
- task definitions
- API schemas
- architecture rules
- verification policies
- security policies
- release policies

Agents may propose changes to these contracts.

They may not silently rewrite them.

Contract changes should be first-class reviewed changes.

---

# 40. The Long-Term Moat

The strongest long-term combination is:

```text
Project Brain
       +
Requirements / Decision Graph
       +
Deterministic Orchestrator
       +
Provider-Agnostic Agents
       +
Evidence Graph
       +
Cost-Aware Routing
       +
Git History
```

This creates institutional memory around a software project.

Models change.

Providers change.

Agents come and go.

Agent Runner retains:

```text
what we decided
why we decided it
what was implemented
how it was verified
what failed previously
what the architecture expects
what remains unfinished
what was released
what happened in production
```

The project is persistent.

Agent sessions are disposable.

---

# What Agentic Dev Runner Should Not Become

Avoid turning the project into:

- another IDE
- another Cursor
- another chat client
- a generic agent framework
- a prompt marketplace
- a generic plugin marketplace
- a replacement for Git
- a replacement for GitHub
- another Jira
- another observability platform
- another deployment platform

Those systems already exist.

Agent Runner should coordinate engineering work across them.

The product identity should remain:

> Agent Runner manages software engineering work. Other tools perform pieces of that work.

---

# Ultimate Developer Experience

A mature interaction might look like:

```text
$ agentic

What are we working on?

> We need teams to be able to invite members by email.

I've analyzed the repository.

Before planning, I need two decisions:

1. Should invitations expire?
2. Can an existing user belong to multiple teams?

> 7 days.
> Yes.

Understood.

I recommend 6 tasks across 3 dependency layers.

4 can use the economy model.
1 requires approval because it changes the database schema.
1 requires a stronger model due to authentication risk.

Estimated model budget:
$1.80–$3.20

Review roadmap?
```

The developer approves.

Agent Runner executes.

Later:

```text
$ agentic status

Feature: Team invitations

6/6 DONE
12 verification runs passed
1 implementation required escalation
0 unresolved review findings
7 commits integrated
Total model cost: $2.36

Release candidate ready.
```

This is the target experience.

---

# Ultimate Product Statement

The product should not be described simply as:

> AI writes code.

Or:

> AI writes specifications.

The stronger statement is:

> Agentic Dev Runner is a persistent senior software engineer that can take responsibility for bounded engineering work across the full SDLC while preserving human control over important decisions.

Its core advantage is that it does not rely only on prompting.

It controls:

- project state
- task boundaries
- workflow transitions
- Git isolation
- scheduling
- agent routing
- verification
- review
- integration
- recovery
- approvals
- audit history
- cost limits
- architectural constraints

That makes the path toward reliable hands-free software engineering substantially more credible.

---

# Strategic North Star

> Build the system a senior engineer would want to trust with real software work.

That means:

- flexible planning
- deterministic execution
- explicit decisions
- bounded autonomy
- independent verification
- architecture protection
- cost-aware routing
- persistent knowledge
- complete evidence
- recoverable execution
- clear human control

The goal is not maximum autonomy.

The goal is dependable engineering leverage.
