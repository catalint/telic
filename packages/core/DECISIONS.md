# telic — decision log

Append-only record of design decisions: what was decided, what was rejected,
and why — written AT DECISION TIME. Newest entries at the bottom. Keep entries
short; link the doc that carries the full reasoning (DESIGN.md / SPEC.md /
PATTERNS.md / APPROACHES.md).

Maintenance rule: any change to the library's design, scope, name, boundaries,
or public API MUST append an entry here in the same change.

Note: telic was designed and proven inside a private production codebase
before extraction. Entries referencing that proving ground are generalized —
the design history is complete; the business specifics are not part of it.

---

## 2026-07-15 — founding day

**D1. Posture: record-first, mediate optionally.** Rejected: full mediation
bus (adoption cliff, competes with state managers) and observability-only
(drops the interop half). Recording works day one beside any state
management; mediation is an opt-in layer earned later. → DESIGN.md.

**D2. Memory = session log + provenance, layered.** The tape IS the memory;
provenance links state activity to causing attempts. Provenance is
progressive (manual → ambient-sync → identity-based adapters), never magical.

**D3. All four consumer stories are v1-core** — humans debugging, analytics,
other frontend domains, AI agents. One declaration must feed all four, or the
Redux lesson repeats (semantics without a paying consumer erode). → DESIGN.md.

**D4. Venue: prototype inside a production monorepo, extract when proven.**
Real pains shape the API before any public commitment; core keeps zero
host-app imports so extraction is mechanical.

**D5. Prior-art verdict: build.** No incumbent occupies the composition;
every strong neighbor became an integration point instead of a competitor:
TanStack Query → adapter (and the hard boundary: telic never owns execution
reliability), User Timing → tap, OTel → optional export tap, XState →
provenance adapter, WebMCP/CopilotKit → complementary agent pairing.
Killed our own claim in the process: analytics CAN express abandonment —
post-hoc, aggregate, warehouse-side; telic's differentiator is real-time,
per-user, in-page.

**D6. Modern-browsers-only scope (Baseline).** Adopted into core: AbortSignal
lifecycle loop (`attempt.signal`, `abandonWhen`, supersede-aborts) and
Navigation-API auto-abandon (soft navs only abandon `boundTo`-violating
attempts). Rejected: WeakRef/GC-based abandon (nondeterministic), Observable
API (single-browser), AsyncContext polyfills (unshipped proposal; a slot is
reserved). `using`/Symbol.dispose: protocol implemented, no core semantics
depend on it. SharedWorker hub adopted as the authoritative cross-tab
transport design; BroadcastChannel stays the zero-setup default.

**D7. Name: telic; npm identity @telic/core under the `telic` org.** Unscoped
`telic` is permanently blocked by npm's similarity moderation ("too similar
to tslib") — for everyone, so unsquattable. Lesson recorded: a registry 404
does NOT mean a name is publishable; the similarity gate fires only at
publish time.

**D8. Fully typed under TS 7.** `isolatedDeclarations` + `erasableSyntaxOnly`
+ strict flags; authored against the native compiler. Standard Schema V1
instead of a zod peer (vendored types-only interface → truly zero-dependency
core; zod remains only where untrusted input needs runtime validation).
Cross-domain typing via the augmentable `IntentRegistry` — the ONE sanctioned
declaration-merge.

**D9. Tests are written FROM SPEC.md, independently of the implementation.**
The clause-numbered spec is normative; impl and tests cross-check each other.
Paid off before any code ran (caught a variance bug in the contract) and on
every expansion since. Keep this discipline.

**D10. The library's own guardrails apply to its authors.** The
`setter-like-name` diagnostic fired on our first taxonomy choice
(`consent.update` → renamed `consent.decide`). Precedent: name intents as
goals, not mutations, starting with our own.

**D11. Module-level handles are late-bound (the orphaned-runtime fix).** A
browser review caught intents recording into a runtime that
`configureDefaultRuntime` had silently replaced — module-scope declarations
evaluate before bootstrap via static import chains. Rule since: ES-module
evaluation order must NEVER matter; module-level intent()/on()/scope()
resolve the current default runtime per call through a registry.
→ SPEC S10.4–S10.7.

**D12. Behavioral proof lives in the unit suite; browser verification is
consolidated, not per-change.** The orphaned-runtime scenario is reproduced
headlessly as a regression test rather than re-verified interactively.

**D13. Mediation layer approved.** The boundary sharpened from "never
executes" to THE INITIATIVE BOUNDARY: telic never owns time or transport; it
only executes caller-provided code synchronously downstream of a caller's
call. One handler per intent (fan-out stays on()'s job); dispatch never
throws (observe via settled); flow() is the saga coordinator-as-a-value
(children, keyed resume, AttemptId-as-Idempotency-Key) while policy stays in
app code. → SPEC S15/S16, DESIGN.md.

**D14. Handler availability: honesty over loading tricks.** Rejected
dynamic-import-inside-handler. Adopted: commands-eager/UI-lazy (static
imports, thin command layers) and presence-based registration
(mount/unmount), with S15.7 parked dispatch (`ifUnhandled: "park"`,
caller-owned `abandonWhen` deadline, FIFO drain on handle()) as the
race-absorber, and live `describe().handled` so agents check invokability
before dispatching. → PATTERNS P10, SPEC S15.7.

**D15. Five-document architecture.** SPEC.md = what (normative,
clause-numbered), DESIGN.md = why (boundaries, risks), PATTERNS.md = how
(P1–P10, AP1–AP8), APPROACHES.md = which (per-axis decision guide),
DECISIONS.md = when/what-changed (this file, append-only).

---

## 2026-07-16

**D16. Owner override of a blocking internal review; release schedule
adjusted to create a soak window.** An independent internal product review
blocked the first production migration of a revenue-path analytics emitter
onto the telic analytics tap, on release-timing risk grounds — its sharpest
technical points: a parity gate proves events-REQUESTED, not sinks-REACHED;
the tap's consent gate is a semantics change vs. hand-rolled emitters; e2e
cannot reach purchase/conversion-dedup events. The project owner overrode
with a schedule adjustment that created the soak window the review demanded.
The review's caveats remained BINDING on the implementation: no consent gate
at the emitter layer on cutover (parity first), a one-word revert const, the
dedup-key persistence format unchanged in both directions, and staging
validation watching REAL analytics sinks. The migration shipped parity-gated
and green under both engines.

**D17. First external adoption review accepted.** A contributor-perspective
review from a second production codebase (Next.js Pages Router + TanStack
React Query + a non-Sentry error vendor + Vitest, GDPR-sensitive domain) set
the public roadmap. Accepted: publishable build with a TS 5.x floor is the
extraction milestone; the React adapter must SPECIFY StrictMode double-mount
and HMR re-declaration semantics, not just provide hooks; the persistence tap
is the checkout-redirect unlock and the next major feature; the TanStack
adapter must answer the internal-retry question; taxonomy lint tooling, a
runner-agnostic /testing subpath, and parity introspection on the analytics
tap are roadmap. Implemented immediately (pre-extraction, because naming and
defaults calcify at publish): vendor-neutral `taps/breadcrumbs` with the
Sentry name as preset alias, `strictPrivacy` + `missing-exposure` diagnostic,
`navigation-unavailable` diagnostic + documented env adapter contract, CI
size gate. One correction recorded: the Navigation API IS Baseline (Jan
2026) — the review's Safari/Firefox claim was outdated — but the
older-version tail argument stands and the diagnostic is right regardless.

**D18. Adoption review round 2 — mediation goes per-runtime; typed command
stubs.** The review's mediation section exposed a design inconsistency we had
waved through: the module-level handler registry was the ONE feature ignoring
telic's own explicit-runtime testing answer, and the global `handled` probe
let embedded runtimes advertise capabilities they couldn't dispatch
(previously documented "not a bug" — from an embedder's seat it is one).
Revised S15.1/S12.5: handler registries are per-runtime; module-level
handle/dispatch follow the default runtime late-bound (the D11 pattern —
also closes a handler-orphaning variant of the runtime bug); explicit
runtimes get `createMediator(runtime)`, isolated by construction. Added
S15.8 `command(name)` typed stubs — the owning domain exports the callable
from its contract subpath, converting rung-3 dispatch from stringly-typed
indirection into an importable late-bound function. Extraction milestone
gains: verify registry augmentation across compiled .d.ts boundaries;
document contract-subpath conventions + scope ownership. Their sequencing
insight recorded: dependency-cycle bans (Nx-style) make reverse-direction
reactions IMPOSSIBLE as imports — rung 2 (`on()`) is the adoption wedge and
needs nothing new.

**D19. Extraction executed.** (a) The public repo is a bun-workspace
monorepo-lite — `packages/core` now, room for `packages/react` etc. without
restructuring churn. (b) Fresh history: code arrives as new commits on the
placeholder repo; the origin monorepo's history stays private. (c) Build:
`tsc` emits ESM + `.d.ts` + maps into `dist/` (erasable-syntax source makes
JS emit trivial; isolatedDeclarations makes declaration emit parallel-safe);
published `exports` point at dist. (d) Compatibility floor: emitted `.d.ts`
must compile under TS 5.5+ — enforced by a CI consumer matrix that ALSO
exercises IntentRegistry augmentation across the compiled declaration
boundary. (e) CI: typecheck, tests, size gate, build, publint +
arethetypeswrong, consumer matrix. (f) Versioning: 0.1.0 initial release +
CHANGELOG.md, semver from here. (g) These docs are CANONICAL in the public
repo from this point; the origin monorepo consumes published versions once
its current release cycle settles. (h) README upgraded from the trimmed
placeholder to the full positioning — the hold-back reason (no code yet) no
longer applies. This public DECISIONS.md is a sanitized derivative of the
founding log: identical decision content, origin-business specifics
generalized.
**D20. v0.2 development venue and scope (2026-07-16).** All new library code
is developed in THIS repo from now on (the origin monorepo's embedded copy is
frozen except critical fixes until it flips to consuming published versions).
v0.2 scope, spec-first as always: node16/nodenext type support via
extensioned relative imports (the durable fix, not a post-build pass);
@telic/react (packages/react — SPEC'd R1–R6 with StrictMode/HMR semantics as
CONTRACTS, and the doctrine that mounts are not intents); persistence tap
(S18) + wire format (S19, hand-rolled validators, still zero deps); TanStack
Query adapter (S20 — internal retries are noted() execution detail on one
attempt, retryOf reserved for user-initiated retries); runner-agnostic
testing subpath (S21); analytics-tap trace hook for CI-assertable migration
parity (S17.7); duplicate-intent fires once per name (S1.3 revised — HMR must
not train diagnostic-blindness). Release automation: publish-on-tag workflow
with npm trusted publishing (OIDC provenance).
