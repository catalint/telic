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

**D21. Release automation approved (owner, 2026-07-16).** Tag-triggered
publish workflow (OIDC trusted publishing with provenance) for @telic/core
and @telic/react, with version-exists guards so manual publishes and re-runs
stay green. First publish of any NEW package remains manual (npm requires the
package to exist before a trusted publisher can be configured). Verification
(typecheck/test/size) runs in the same job before any publish.

**D22. No server runtime — server correlation is a contract (2026-07-16).**
Evaluated porting telic (or subsets) to the server; rejected. Server-side,
every differentiating pillar has a mature owner: OpenTelemetry owns semantic
tracing, workflow engines (Temporal-class) own durable sagas — by OWNING time
and transport, the opposite of telic's initiative boundary — and `abandoned`
barely exists where requests complete or error. A process-wide tape would
also interleave concurrent users (the same reason SSR mode is silent).
Adopted instead: PATTERNS P11 — the attempt id already travels as the
Idempotency-Key, so a ~30-line vanilla middleware joins the client's intent
timeline to OTel spans/baggage and structured logs; a dev-mode response-header
channel can flow server breadcrumbs back into the client tape via wire +
ingest. AP9 records the anti-pattern. This makes telic complementary to OTel
shops rather than competitive with them.

**D23. v0.3.0 — the roadmap finalized (2026-07-16).** Shipped: all three
transports (BroadcastChannel gossip, postMessage with mandatory origin
allow-listing, SharedWorker authoritative hub — forward-only by design: no
onAttach backlog re-broadcast, catch-up is exclusively the hub's snapshot
request; loop safety is send-side via foreign-origin checks); XState adapter
(bindActor identity registration, no ambient fallback — machine lifetimes
outlive call stacks; settleFromMachine's map-return IS the outcome knob);
Trusted-Types-safe plain-DOM devtools; OTel tap (structural tracer). New
package @telic/lint (peer typescript >= 5.5) — recorded finding: TypeScript
7's native compiler REMOVED the classic programmatic API from the root
export (relocated to unstable/*), so tooling that consumes the compiler API
must build against 5.x/6.x while 7-native remains typecheck/emit-only; the
lint CLI dev-builds on 5.9 and runs on whatever the host provides >= 5.5.
Docs: PostHog recipe with trace-based CI parity, P12 contract-subpath
conventions. Remaining roadmap after this release: intentionally empty —
future work is demand-driven (AsyncContext Tier-1.5 when the platform ships
it; anything else arrives as adopter asks).

**D24. The workspace-protocol publish bug and its guard (2026-07-16).**
@telic/react@0.1.0 shipped to npm with a literal `workspace:^` peer dependency
— unresolvable for every consumer. Root cause: pack-tool mismatch — the
package was VERIFIED with `bun pm pack` (which rewrites workspace ranges) but
PUBLISHED with `npm publish` (which does not). Fixed in 0.1.1 (real semver
range, 0.1.0 deprecated) and guarded permanently: the release workflow now
fails before publishing if any publishable manifest field contains a
workspace: range. Rule: verification must run through the SAME tool as the
production path — a lesson this project already learned once at the analytics
sink level (D16's events-requested vs sinks-reached) and now re-learns at the
packaging level.

**D25. AI-agent legibility layer (2026-07-16).** Three artifacts, three
audiences: `llms.txt` (repo root) for agents fetching context; `AGENTS.md`
(+ CLAUDE.md pointer) for agents contributing to the repo; `AI-GUIDE.md`
SHIPPED IN THE NPM PACKAGE for agents using telic inside consuming codebases
— the five-rule condensed contract (lifecycle test, no PII on the tape,
memory-not-truth, boundaries-only dispatch, prefer run()) plus a paste-block
for host agent configs. Rationale: docs that live in node_modules are the
only docs a coding agent reliably has at hand; the spec-first discipline
already produced agent-grade material — this packages it for discovery.

**D26. A re-declared handle records with the FIRST config, not the second
(2026-07-16).** `describe()` always reported the first declaration's config
(S12.1), but the handle RETURNED by a runtime-level re-declaration was being
built from the freshly-passed config — so a second `intent(name, …)` (HMR
re-eval, or two call sites) with a weaker `exposure`/`redact` produced a live
handle that recorded RAW payloads while `describe()` still advertised the
strict first config. A privacy audit reading `describe()` could not see the
divergence. Decided: `declareIntent` now mirrors what `declareOrGet` already
did for the module-level facade — it rebuilds the returned handle (and gates
the `missing-exposure` diagnostic) from the stored first config. First-config-
wins is now the invariant for BEHAVIOR, not just the descriptor. Rejected:
letting the second config win (would make re-declaration a silent redaction-
bypass vector); making re-declaration throw (violates S1.3's "the second
declaration still works"). SPEC: S1 amendment (3-revised) extended.

**D27. Dynamic reads on plain objects keyed by untrusted strings must be
OWN-property lookups (2026-07-16).** Three sites indexed a plain object literal
with a string sourced from user/model input — an xstate machine state name
(`xstate.ts`), a lint intent scope name (`lint/rules.ts`), a flow step name
(`flow.ts`) — and one built such a map by write (`lint/config.ts`). A key
colliding with an `Object.prototype` member (`toString`, `constructor`,
`__proto__`, `valueOf`, …) resolved the INHERITED value instead of `undefined`,
bypassing the `=== undefined` guard and either crashing (`.map`/`.reject` on a
function) or polluting the accumulator's prototype. Decided: any such read uses
`Object.hasOwn(obj, key) ? obj[key] : undefined`, and any such accumulator is
built prototype-free (`Object.create(null)`). This is a repo convention, not a
one-off: it feeds the Copilot review instructions and is the reason the crash
class can't silently regress. Rejected: sanitizing/rejecting the offending key
names (telic does not own its callers' state or intent taxonomies — a state
literally named `constructor` is valid and must simply be handled).

**D28. The data boundary — telic honors data policy, it never authors or
overrides it (2026-07-16).** The twin of the initiative boundary (never own time
or transport), pointed at data instead of action: telic records, gates, and
surfaces gaps loudly, but it never transforms the semantic content of a value it
moves (except through a caller-supplied mapping), never decides where data may
travel on the caller's behalf, and never overrides or relaxes a reach the caller
declared. `exposure` is a caller policy telic must honor — and must fail CLOSED on
when it cannot recover it, never defaulting to the most-exposing value. The
content mapping is a caller-owned seam telic only invokes. The security boundary
(no raw identities on the tape — AP7) stays with the caller; telic makes only a
FIDELITY promise: never move data further than the caller allowed, and never
invent a policy when it has lost the caller's. Consequences of this entry: the
`redact`→`transform` rename and the `missing-exposure` decoupling (D29), and the
fail-closed / never-upgrade fixes owed to the two open exposure leaks (#5, #8,
listed under DESIGN "Risks we carry knowingly"). Rejected: framing telic as a
privacy/security layer — it cannot keep a leak-proof promise and should not imply
one (a three-level enum graded as a security boundary that leaks invites misplaced
trust); a built-in PII detector/scrubber — that is telic deciding for the caller,
the exact drift this boundary forbids. DESIGN: "The data boundary" section.

**D29. `redact` renamed to `transform`; `missing-exposure` keys off `exposure`
alone (2026-07-16).** The config field was named for one use (PII redaction) of a
mechanism that is general — a write-time payload→mark mapping equally good for
downsampling, normalization, and classification. Naming the purpose (a) understated
the field and (b) made `exposure` + `redact` both read as "the privacy layer",
conflating a reach policy with a content mapping. Renamed to `transform` (the
mechanism, per D28). Because a `transform` is no longer a privacy signal, its
presence no longer suppresses the strictPrivacy `missing-exposure` diagnostic
(S1.5): the gate narrows from "no `exposure` AND no `redact`" to "no explicit
`exposure`", which also makes the diagnostic's name honest. Scope: payload-only,
unchanged — outcomes are still recorded as-is; a symmetric outcome mapping is a
separate future decision, deliberately deferred. BREAKING (field rename + a
strictPrivacy firing that was previously silent); adoption is ~zero, so a clean
rename with no deprecated alias. Rejected: `recordAs`/`project` (over-claim mark-
or projection-wide when the seam is payload-only); keeping `redact` (purpose-laden,
sustains the privacy-layer conflation D28 unwinds); a `redact` alias (debt for no
adopter). SPEC: S1.5 rewritten, S2.1 reworded; type `IntentConfig.transform`.

**D30. Privacy leaves telic's realm entirely; `exposure`, `transform`, and the
`strictPrivacy`/`missing-exposure` diagnostic are removed (2026-07-16).** D28
drew the data boundary and D29 renamed `redact`→`transform` to unwind the
"privacy layer" framing; carrying that reasoning to its end, the whole
payload-egress surface was cut. Removed: the `exposure` reach class
(`full`/`local`/`private`) and its `"[private]"` payload mask; the `transform`
write-time payload mapping (this SUPERSEDES the rename half of D29 — the field no
longer exists in any form); the `strictPrivacy` runtime option and its
`missing-exposure` diagnostic (S1.5, now a tombstone); and every egress filter
those drove — snapshot exclusion (S6.7), persistence's local-skip (S18.2), and
the transports' local/private gates (S22–S24). telic core now records a mark and
holds zero opinion about where it goes; taps/persistence/transports forward
everything, and scoping is the caller's `send`/pattern filter at wiring time.
Why: the boundary D28 states already says telic does not author data policy, and
an intent-level reach enum was telic authoring exactly that. Its two legitimate
uses both belong elsewhere — privacy metadata is the caller's realm (AP7,
"classifications only on the tape"), and noise/correctness scoping is expressible
where a transport or storage tap is wired. Keeping the enum also carried real
cost: two open leaks — `exposure` recoverable only from `begun` marks (#5),
`flow()` upgrading a `local` child's reach (#8) — existed ONLY because the enum
existed; both dissolve with it, and both DESIGN "Risks we carry knowingly" rows
are removed accordingly. Cost accepted: attaching a broadcast/persistence tap now
forwards ALL marks by default; a caller wanting a subset scopes it at attach time
(`send`/`accept` patterns), the same seam that already existed. A per-mark
`filter(mark) => boolean` egress hook on the taps/transports was considered and
DEFERRED (YAGNI): the pattern filters cover the known need, and adding a second
scoping mechanism before an adopter asks for it would re-introduce the
telic-authored policy surface this decision exists to remove — if a real case
appears, that hook is the sanctioned escape hatch. BREAKING (removes public
config fields, a runtime option, a diagnostic, and the `exposure` wire field — a
tolerant reader ignores a stale `exposure` on old marks, so no migration);
adoption is ~zero, so a clean cut. SPEC: S1.5/S7.4 tombstoned,
S2.1/S6.7/S12.1/S14.2/S18.2/S22–S24 excised; types `Exposure`,
`IntentConfig.transform`/`.exposure`, `RuntimeOptions.strictPrivacy`, and the
`missing-exposure` diagnostic deleted.

**D31. Agent descriptor — the caller projects the shape, telic only forwards
it (2026-07-18).** COMPARISON.md's "agent-callable" claim was half-true:
`describe()` told an agent a payload schema exists (`hasPayloadSchema: true`,
S12.1) but never its shape, so an agent could not actually construct a valid
payload (PROPOSALS PR-1). Decided: `IntentConfig`/`IntentDescriptor` gain an
optional `agent: { summary?: string; input?: unknown }` (new `AgentDescriptor`
type). The caller projects `input` itself (a hand-written or
`z.toJSONSchema`-derived JSON Schema, or anything else) and telic forwards it
VERBATIM through `describe()` — it derives, validates, and transforms nothing,
the same discipline D28/D30 already commit to for payload data. First-
declaration-wins (S1.3-revised/D26): a re-declaration's differing `agent` is
ignored, exactly like `tags`/schemas — no diagnostic either way. The wrapper
telic returns is its own (frozen along with the descriptor entry per S12.2),
but the caller's `input` value is forwarded BY REFERENCE and never deep-frozen
— it is the caller's object, and freezing it would be telic authoring over
data it does not own. Rejected: telic deriving a JSON Schema itself from the
Standard Schema payload (Standard Schema v1 is validation-only and exposes no
shape, so this would require a dependency — violates zero-runtime-deps);
telic defining its own projection format/policy (that is telic authoring data
policy, the exact drift D28 forbids — the caller already owns the shape and
telic's only job is not to lose it in transit). SPEC: S1.6, S12.6 added.

**D32. Duplicate-instance sentinel made real; README's claim was aspirational
(2026-07-18).** README §5 already asserted telic "ships a dev-mode
duplicate-instance detector (window sentinel)" — no such mechanism existed in
code. PROPOSALS PR-3 proposed promoting the idea from dev-mode to an always-on
check; this decision ships it, correcting the README claim to match reality
rather than the reverse. `createRuntime` now probes a well-known `globalThis`
key (`__TELIC_CORE__`) at creation time, gated to browser-like environments
only (`typeof document !== "undefined"`, the same S10.4 gate the default
runtime uses — no module-scope env access, SSR-safe). The FIRST loaded copy of
`@telic/core` to create a runtime claims the key with a per-module identity
token; a later creation that finds the key held by a DIFFERENT token fires the
new `duplicate-instance` diagnostic on the runtime being created — proof two
copies of the module are loaded, each with its own tape and mediation
registry (the micro-frontend/Module-Federation-version-skew footgun the
README section is about). Multiple runtimes is not multiple copies: explicit
`createRuntime()` calls within ONE loaded copy are a supported pattern
(multi-runtime embedders, S10.1) and share that copy's token, so they never
fire — only a genuinely distinct module copy does. Fires at most once per
probed host per module copy, COUNTED ON DELIVERY, and never overwrites the
first claimer's ownership. Delivery-counting is load-bearing, not a detail:
the lazy default runtime is created without `onDiagnostic` (S10.4), so a
detection there would otherwise burn the once-budget into the void and
permanently silence the `configureDefaultRuntime({ onDiagnostic })` the
recipe tells users to wire — the exact consumer the diagnostic exists for.
Since the probe already re-runs at every runtime creation (configure routes
through creation, S10.5), re-detecting until a handler-bearing runtime
appears costs two property reads and needs no state beyond a per-host
delivered set — which also makes tests order-independent (fresh host = fresh
accounting). Rejected: throwing on detection; re-claiming/re-firing on every
later duplicate creation (spam / breaks legitimate embedding); and a
detection latch that re-fires on configure — redundant cache of a fact the
probe re-reads live each creation, and falsifiable across injected hosts
unless further keyed per host, at which point it reduces to the chosen
design. Known, accepted limit: the diagnostic fires only on the LATER-loaded
(losing) copy; if that copy never creates a handler-bearing runtime, nothing
is delivered anywhere — a best-effort tripwire, with the build-time
singleton config as the actual fix (the recipe states this). A data-only
breadcrumb on the shared key (making the fact page-globally queryable by
devtools/agents) was considered and DEFERRED: it upgrades the opaque token
to a versioned cross-copy format — its own wire-contract decision, and
version skew between copies is a trigger condition of this very bug, so any
shared shape must be designed version-tolerant deliberately, not as a rider
here. The
probe target is injected via a new `InstanceSentinelEnv` (`{ browserLike,
host }`) second `createRuntime` parameter, mirroring
`connectBrowserLifecycle`'s `env` seam, so tests never touch the real
`globalThis`. Docs: `packages/core/docs/recipes/micro-frontends.md` pairs the
fix with Module Federation `shared: { singleton: true }` / single-spa
import-map wiring and shows confirming a single instance via `onDiagnostic`
matching `diagnostic.code === "duplicate-instance"`. SPEC: S10.8 added.

**D33. telic's guidance ships as an installable agent skill (2026-07-18).**
PROPOSALS PR-5, prompted by finding Vercel's `composition-patterns` agent
skill during the competitive review: design guidance distributed AS an
installable artifact for coding agents, not prose an agent must discover and
distill. telic's equivalent material already existed (PATTERNS P1–P12 /
AP1–AP9, AI-GUIDE.md) but only in-repo. `skills/telic-intents/`
(SKILL.md + AGENTS.md, mirroring the vercel-labs/agent-skills layout so
`npx skills add` resolves it) now carries the distilled rules — 18 rules in
five priority categories, each with before/after and its diagnostic tie-in.
PATTERNS.md remains the SOURCE OF TRUTH: the skill is a distillation of it,
and the conventions gate enforces referential integrity (every `P#`/`AP#`
cited in the skill exists as a PATTERNS.md heading; every diagnostic code
cited exists in the types.ts `Diagnostic` union), so a renamed pattern or
diagnostic breaks CI rather than silently orphaning the skill. Rejected:
generating the skill from PATTERNS.md (the two serve different readers at
different granularity — a generator would flatten the distillation into
duplication); and putting the skill under packages/core (it documents the
whole library posture, and the vercel-labs convention is a repo-root
`skills/` directory). Also in this change: the cross-realm design doc's
draft decision entry is now NUMBER-AGNOSTIC ("D-next") — a draft that pins a
concrete D-number collides with real decisions landing first, which happened
twice in two days. Dogfoods the library's own thesis: a library selling an
agent surface should be adoptable by agents.
