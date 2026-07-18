# Open proposals — things the competitive review surfaced

These are **open proposals**, not decisions. They came out of writing
[COMPARISON.md](COMPARISON.md) (telic's mediation layer against MediatR, NestJS CQRS,
Comlink, single-spa, Module Federation, Redux, and the DI containers). When one is
accepted or rejected it graduates to an append-only entry in [DECISIONS.md](DECISIONS.md);
until then nothing here is committed. Ordered by value-to-effort, sharpest first.

---

## PR-1. Expose the payload *shape* to agents, not just its existence

**Status: Implemented → D31.**

**Problem.** telic's headline differentiator on P7 is that a capability is
*agent-invocable* — an agent dispatches `"cart.addItem"` with a JSON payload. But an
agent cannot construct a valid payload from what we expose today.
`describe()` returns `{ name, tags, hasPayloadSchema }` ([SPEC S12.1](SPEC.md)) and the
agent surface delegates that verbatim ([SPEC S14.2](SPEC.md)) — so an agent learns a
schema *exists* (`hasPayloadSchema: true`) but never learns its *shape*. It's a locked
door with a sign saying "this door has a lock." The "agent-callable" selling point in
[COMPARISON.md](COMPARISON.md) is, right now, half-true.

**Evidence from the review.** This is the one axis where nothing else competes (MediatR's
class-as-message and DI's typed interfaces are unreadable to a runtime agent). It is worth
making *real* rather than aspirational.

**Tension.** Core is schema-agnostic (Standard Schema — Zod/Valibot/ArkType) and
zero-dep. Standard Schema v1 is validation-only; it exposes no JSON Schema. So telic
cannot *derive* a shape generically without either a dependency or caller cooperation.

**Sketch (keeps the boundary).** Let the intent declaration carry an optional, already-
projected descriptor the caller owns:

```ts
intent("cart.addItem", {
	payload: cartItemSchema,
	// optional, opt-in, caller-produced (e.g. zod 4's z.toJSONSchema, or hand-written):
	agent: { input: cartItemJsonSchema, summary: "Add a SKU to the cart" },
})
```

`describe()` (and thus the agent surface) then surfaces `agent` when present. telic
projects nothing itself — it *forwards* what the caller declared, exactly as the data
boundary (D30) says it should. Zero-dep intact; agents get a real, dispatchable contract.

**Effort:** small (additive field on the intent config + descriptor). **Risk:** low.

---

## PR-2. Cross-realm dispatch — dispatch to a handler that lives elsewhere

**Status: Design pass complete → `docs/design/cross-realm-dispatch.md` — awaiting decision.**

**Problem.** `dispatch` resolves a handler in **one runtime's** mediation registry
([SPEC S15](SPEC.md)). telic already forwards *marks* across realms — BroadcastChannel
(S22), postMessage (S23), SharedWorker (S24) — so the **record** crosses tabs, iframes,
and workers. But the **command** does not: you cannot `dispatch` to a `handle` registered
in another window/worker/Module-Federation remote.

**Evidence from the review.** Comlink crosses a worker boundary; Module Federation crosses
a deployment boundary; both do *invocation* across the line. telic does *observation*
across the line but stops at same-realm for invocation. For true cross-app/agent
orchestration this is the missing half.

**Tension — the load-bearing one.** The initiative boundary says telic never owns
transport. A naive "remote dispatch" would make telic open channels and manage delivery —
exactly what [DESIGN.md](DESIGN.md) forbids.

**Sketch (respects the boundary).** The **caller owns the channel** (a `MessagePort`, a
`BroadcastChannel`, a Comlink proxy); telic contributes only **correlation**: a dispatch
whose handler is remote sends the payload + the AttemptId over the caller's channel, the
remote side runs its local `handle`, and settlement marks flow back over the *same* mark
transports we already ship — stitched to the originating attempt by id. telic never times,
retries, or reconnects; a dead channel is the app's problem (as S24.3 already states for
SharedWorker). Effectively: `handled` and settlement become answerable across a
caller-provided seam, without telic growing a transport of its own.

**Open questions.** How `handled` is probed across the wire (round-trip vs. advertised
manifest); how parked dispatch (S15.7) interacts with a remote that hasn't registered yet;
whether this is `@telic/core/mediate` or a new `/transports/remote-dispatch` subpath.

**Effort:** large; needs a design pass + a DECISIONS entry before any code. **Risk:**
medium-high (it's the closest telic would come to the initiative boundary — the framing
above is what keeps it on the right side).

---

## PR-3. Harden the single-shared-instance requirement for micro-frontends

**Status: Implemented → D32.**

**Problem.** telic's cross-domain story assumes **one** runtime instance shared by every
island/MFE. Independently-built bundles that each duplicate `@telic/core` create two tapes
that each hear half the app — [README §5 flags this](../../README.md) as "a real footgun,
not an edge case," and both the single-spa and Module Federation verdicts in
[COMPARISON.md](COMPARISON.md) hit it.

**Evidence from the review.** Module Federation's `shared` option is the *actual* fix and
we don't document it; single-spa users hit the same wall.

**Sketch.**
1. **Docs:** a short "micro-frontend setup" recipe — declare core as a singleton shared
   dep (`shared: { "@telic/core": { singleton: true, requiredVersion: "^x" } }` for MF;
   an import-map singleton for single-spa) — living beside the PostHog recipe.
2. **Runtime:** promote the existing dev-mode duplicate-instance sentinel from "dev-mode"
   to an always-cheap `globalThis` check that fires a `duplicate-instance` diagnostic once
   when a second core instance boots — an honesty guarantee, matching how
   `navigation-unavailable` (S10.6) refuses to degrade silently.

**Effort:** small (a recipe + one sentinel diagnostic). **Risk:** low.

---

## PR-4. Cite the prior art in the pattern docs

**Status: Done.**

**Problem.** [PATTERNS.md](PATTERNS.md) presents P7 and AP4 as if invented here. They
stand on well-known ground, and saying so is more credible than implying novelty.

**Sketch (doc-only).**
- **AP4** ("Dispatch as a fashion statement"): one line citing the MediatR
  ["you probably don't need it inside your domain"](https://arialdomartini.github.io/mediatr)
  debate, and naming DI containers (tsyringe/inversify) as the *typed* alternative when you
  don't need recording or an agent.
- **P7:** one line naming NestJS CQRS / MediatR as the mechanism's mature incumbents, so
  the novelty claim narrows honestly to the lifecycle + agent surface.
- **README:** add [COMPARISON.md](COMPARISON.md) to the documentation table and cross-link
  it from "Isn't this just X?".

**Effort:** trivial. **Risk:** none.

---

## PR-5. Ship telic's guidance as an installable agent skill

**Status: Implemented → D33.**

**Problem.** Vercel distributes its React composition guidance as an installable AI-agent
skill ([vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills), `npx skills
add … --skill vercel-composition-patterns`): priority-tagged rules with before/after
examples, written *for coding agents* refactoring codebases. telic already has exactly that
material — AI-GUIDE.md, PATTERNS.md's P1–P10/AP1–AP8, the S15 discipline — but only as
in-repo prose an agent must discover and distill itself.

**Sketch.** A `skills/telic-intents/` artifact in the vercel-labs format (SKILL.md +
AGENTS.md): rule-per-pattern with the existing before/afters (declare-don't-set, one
handler per capability, dispatch only across boundaries, memory-not-truth, run() over
manual begin/settle), each carrying its priority and its diagnostic tie-in
(`setter-like-name`, `handler-replaced`, `duplicate-instance`). Content is a distillation,
not new writing — PATTERNS.md stays the source of truth; the skill is a build artifact of
it. Dogfoods the thesis: a library selling an agent surface should be adoptable *by*
agents.

**Effort:** small (doc transform + repo packaging). **Risk:** low (drift between
PATTERNS.md and the skill — mitigate by generating or cross-checking in CI's
conventions gate).

---

## Not proposed (considered, deliberately declined)

- **A dispatch pipeline / middleware** (MediatR's `IPipelineBehavior`, NestJS interceptors).
  Rejected on sight: cross-cutting work is a **tap** (observation) or the caller's, never a
  telic-owned pre/post hook. A pipeline is how initiative sneaks back in.
- **Multiple handlers per command** (fan-out on `dispatch`). Already settled — fan-out is
  `on()`'s job ([DESIGN.md](DESIGN.md), "why one handler per intent"). Listed here only so
  the review's "NestJS events support many handlers" note doesn't get mistaken for a gap.
