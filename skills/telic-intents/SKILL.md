---
name: telic-intents
description:
  Recorded user-intent patterns for frontends using @telic/core. Use when
  declaring intents, recording attempt lifecycles, wiring handle/dispatch
  across domain boundaries, or refactoring analytics, breadcrumb, or saga
  code onto the intent tape. Triggers on tasks involving intent naming,
  attempt settlement, cross-domain invocation, micro-frontend wiring, or
  exposing user state to AI agents.
license: MIT
metadata:
  author: telic
  version: '1.0.0'
---

# telic Intent Patterns

Rules for modeling, recording, and mediating user intents with
[`@telic/core`](https://www.npmjs.com/package/@telic/core). Distilled from the
library's own [PATTERNS.md](../../packages/core/PATTERNS.md) (P1–P12,
AP1–AP9), which remains the source of truth; the repo's conventions gate
cross-checks this skill against it.

## When to Apply

Apply these rules when:

- Declaring new intents or reviewing intent names
- Recording attempt lifecycles (`begin`/`fulfill`/`reject`/`abandon`, `run()`)
- Wiring capabilities across domain boundaries (`handle`/`dispatch`/`command`)
- Coordinating multi-domain flows (`flow()` vs event choreography)
- Setting up micro-frontend or islands architectures with a shared runtime
- Exposing behavioral state to AI agents, copilots, or test explorers
- Refactoring hand-rolled analytics dedup, breadcrumb calls, or funnel events

## Rule Categories by Priority

1. **Intent Modeling** (HIGH) — what deserves to be an intent at all
2. **Recording** (HIGH) — settlement, memory, cancellation, page scope
3. **Mediation** (MEDIUM) — when dispatch earns its keep, and when imports win
4. **Flows & Reactions** (MEDIUM) — coordination vs choreography, replay, analytics
5. **Environment** (MEDIUM) — server boundaries, single-instance, agent surface

## Quick Reference

### 1. Intent Modeling

- `model-lifecycle-litmus-test` - Every intent must answer "what does rejected
  mean? when is it abandoned?" — no answer means it's a mutation, not an intent
- `model-abandoned-is-not-rejected` - A user walking away is not a failure;
  settle the two differently
- `model-classifications-not-identities` - Payloads carry classifications,
  never raw identities or secrets; nothing downstream scrubs

### 2. Recording

- `record-run-over-manual-pairs` - Prefer `run()`; settlement by construction
  beats remembering to settle
- `record-memory-is-not-truth` - Never render primary UI from attempt state;
  telic is memory, not a state manager
- `record-cancellation-from-identity` - Key + `onConflict` + `attempt.signal`
  replace hand-rolled AbortController choreography
- `record-attempts-are-page-scoped` - No cross-page attempts without the
  persistence tap; navigation abandons by design
- `record-bind-to-whole-territory` - Scope `boundTo` to the flow's whole URL
  territory, or a wizard abandons itself

### 3. Mediation

- `mediate-dispatch-only-across-boundaries` - Within your own domain, call
  your own functions; dispatch crosses domains and serves agents
- `mediate-one-handler-no-state` - One executor per capability; handlers call
  the domain's store, they never hold state
- `mediate-presence-is-honesty` - Register handlers where their availability
  is true (eager commands, or mount/unmount); "no handler" must be a fact
- `mediate-contract-subpaths` - Cross-package invocation goes through a
  types-only contract subpath; one file owns each scope

### 4. Flows & Reactions

- `flow-coordinator-never-choreography` - Money paths get one explicit
  coordinator; never a chain of `on()` reactions
- `react-replay-for-late-subscribers` - `{ replay: true }` when mount order is
  undefined and history matters; skip it when mount resolves fresh state
- `analytics-declare-once` - Funnels are rules over intents with mechanical
  `once` dedup, not hand-maintained fired-event sets

### 5. Environment

- `env-server-joins-never-records` - telic does not run on the server; the
  server joins the client timeline via the attempt id (Idempotency-Key)
- `env-one-shared-instance` - Micro-frontends must share ONE `@telic/core`
  instance; two copies mean two half-deaf tapes
- `env-agent-surface-is-read-only` - Agents read `describe()`/`inProgress()`
  and invoke via dispatch; the surface itself never mutates

## How to Use

Read the full compiled rules in [AGENTS.md](AGENTS.md) — each rule carries a
before/after example, the failure it prevents, and its tie-in to telic's
diagnostics (`setter-like-name`, `handler-replaced`, `duplicate-instance`, …)
so violations found in review can be traced to the mechanical check that
should have caught them.

## Full Compiled Document

See [AGENTS.md](AGENTS.md).
