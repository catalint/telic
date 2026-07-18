# Recipe: Micro-frontends

The single-shared-instance requirement, made concrete: what actually breaks
when a micro-frontend setup ends up with two copies of `@telic/core`, the two
fixes (Module Federation's `shared` singleton, single-spa's shared import
map), how to CONFIRM at runtime that you only have one instance, and the
honest limit — cross-realm (cross-tab, cross-origin) setups can forward
history but cannot merge registries, because that isn't the same problem.

## 1. The failure mode, concretely

`@telic/core`'s module-level API — `intent`, `handle`, `dispatch`, `on`,
`memory` — binds to THE DEFAULT RUNTIME, lazily created the first time any of
it is touched (S10.4). That runtime owns exactly one tape (S4) and exactly
one mediation registry (S15.1). Both live in the module's own closure. If a
bundler emits `@telic/core` into two separate chunks — two independently
built MFEs, a host + a remote that didn't dedupe the dependency, a monorepo
with two resolved versions — each chunk evaluates the module fresh and gets
its OWN default runtime. Two tapes. Two registries. Nothing links them; each
one hears exactly half the app.

This doesn't throw, and it doesn't look like a bundling problem. It looks
like a race, or a missing registration:

- **`dispatch` finds no handler.** The cart MFE calls `handle("cart.addItem",
  …)` on ITS copy's registry. The checkout MFE calls `dispatch("cart.addItem",
  …)` on ITS OWN copy's registry — a different one. Per S15.3 the attempt is
  begun and immediately rejected with `{ code: "TELIC_NO_HANDLER" }` plus
  diagnostic `no-handler`, exactly as if the cart MFE had never mounted. If
  you reach for `{ ifUnhandled: "park" }` (S15.7) to paper over what looks
  like a mount-order race, it won't help — parking drains when `handle` is
  called on the SAME registry, which never happens here. The attempt just
  stays parked forever.
- **`on(…, { replay: true })` replays half the history.** Replay (S5.4)
  synchronously delivers RETAINED matching marks — from the tape the listener
  is registered on. A domain mounted in copy B that subscribes with `replay:
  true` only ever sees marks copy B's own runtime recorded. Whatever happened
  through copy A before B mounted is invisible — not evicted, not delayed,
  simply never on B's tape. The "a late-mounted island still hears the past"
  guarantee (the reason `replay` exists at all) silently degrades to "hears
  the past IF IT HAPPENED THROUGH THE SAME COPY."

Both symptoms present as application bugs — "the handler isn't registering,"
"replay is flaky" — and neither will reproduce in a single-bundle dev setup,
only once real independently-built MFEs are wired together. Confirm the
instance count (§4) before debugging further.

## 2. Module Federation fix — `shared` singleton

Module Federation owns *load* transport; it does not dedupe a dependency
across host and remote unless told to. Mark `@telic/core` as a singleton
shared module — this is the actual fix, on both sides:

```js
// host: webpack.config.js
const { ModuleFederationPlugin } = require("webpack").container

module.exports = {
	plugins: [
		new ModuleFederationPlugin({
			name: "host",
			remotes: {
				checkout: "checkout@https://checkout.example.com/remoteEntry.js",
			},
			shared: {
				"@telic/core": {
					singleton: true,
					strictVersion: true,
					requiredVersion: "^0.4.0",
				},
			},
		}),
	],
}
```

```js
// remote (checkout MFE): webpack.config.js
const { ModuleFederationPlugin } = require("webpack").container

module.exports = {
	plugins: [
		new ModuleFederationPlugin({
			name: "checkout",
			filename: "remoteEntry.js",
			exposes: { "./CheckoutApp": "./src/CheckoutApp" },
			shared: {
				"@telic/core": {
					singleton: true,
					strictVersion: true,
					requiredVersion: "^0.4.0",
				},
			},
		}),
	],
}
```

`singleton: true` is the load-bearing option — it makes MF resolve every
consumer to the SAME loaded module instead of letting each remote bring its
own copy. `strictVersion: true` turns a version mismatch into a hard build
error instead of a silent "close enough" resolution — you want a
CI-visible failure over a THIRD copy sneaking in because someone bumped
`@telic/core` in one repo and forgot the other. `requiredVersion` pins the
range explicitly rather than trusting whatever each `package.json` happens to
say. rspack's `ModuleFederationPlugin` (`@rspack/core`'s
`rspack.container.ModuleFederationPlugin`) takes the identical `shared`
shape — swap the import, keep the config.

## 3. single-spa / import-map fix — shared, externalized

single-spa doesn't route through a federation runtime; it loads each MFE as
its own SystemJS/ESM module via an import map. The fix is the same idea
wearing different clothes: serve `@telic/core` from exactly ONE URL in the
shared import map, and have every MFE mark it `external` in its own build so
none of them bundle their own copy.

```json
{
	"imports": {
		"@telic/core": "https://cdn.example.com/telic-core@0.4.0/core.js",
		"cart-mfe": "https://cdn.example.com/cart-mfe/cart-mfe.js",
		"checkout-mfe": "https://cdn.example.com/checkout-mfe/checkout-mfe.js"
	}
}
```

```js
// each MFE's webpack.config.js — do NOT bundle @telic/core, resolve it
// against the import map at runtime instead
module.exports = {
	externals: {
		"@telic/core": "@telic/core",
	},
}
```

Every MFE's build must externalize it — externalizing in the host but
bundling it in one remote reintroduces exactly the two-copy failure mode from
§1, just via a different mechanism than Module Federation's `shared`. There's
no `singleton`/`strictVersion` safety net here: an import map has one entry
per specifier by construction, so "two copies" can only happen if some MFE's
build didn't externalize — verify with §4, not by inspection of the map.

## 4. Verification — confirm ONE instance at runtime

Don't take the build config's word for it. `@telic/core` fires diagnostic
`duplicate-instance` when a second copy of the core module boots in a
browser environment — this is current behavior, not aspirational: an
always-on `globalThis` check, not a dev-only sentinel. It is delivered at
most once per copy, and only to a runtime that has an `onDiagnostic` — a
detection before you configure burns nothing, so the wiring below hears it
even when module-evaluation order created the default runtime first.
Wire it through `onDiagnostic` on whichever runtime you configure:

```ts
import { configureDefaultRuntime } from "@telic/core"

configureDefaultRuntime({
	onDiagnostic: (diagnostic) => {
		if (diagnostic.code === "duplicate-instance") {
			// a second copy of @telic/core just booted in this tab — the
			// MF `shared` config or import-map externals aren't working
			reportToMonitoring("telic-duplicate-instance")
		}
	},
})
```

Ship this in every environment you can, not just locally — the failure mode
in §1 is a property of how the REAL, independently-deployed bundles resolve
at runtime; a local dev build with everything in one webpack config will
never reproduce it, and a staging deploy assembled from separately-built MFE
artifacts is the first place a `shared`/externals misconfiguration actually
shows up.

One honest limit: the diagnostic fires on the LATER-loaded copy — the one
that lost the claim race. If the duplicate arrives via a bundle that never
wires a runtime of its own (a remote that only declares intents and
dispatches), there is no handler on that copy and nothing fires anywhere.
Treat `duplicate-instance` as a best-effort tripwire, not proof of health:
the `shared`/import-map config in §2–§3 is the actual fix, and the
`describe()` cross-check below covers the direction the tripwire can't.

A second, cheap sanity check: with a true singleton, `describe()` called from
ANY MFE's copy of `@telic/core` enumerates intents declared by EVERY MFE —
they all share one registry. If `describe()` from the checkout MFE is missing
intents you know the cart MFE declares, that's the same signal as
`duplicate-instance`, arrived at from the other direction.

## 5. When you cannot share one instance

Everything above fixes the SAME-REALM case — one browser tab, one JS heap,
multiple independently-built bundles that need to resolve to one module
instance. It does not, and cannot, apply across a REAL realm boundary: a
different browser tab, a cross-origin iframe, a separate worker. Those are
different JS heaps by construction — no bundler config makes two tabs share
one module instance.

telic ships transports for exactly that boundary: `connectBroadcastChannel`
(S22, cross-tab) and `connectWindow` (S23, cross-origin `postMessage`). Read
their guarantee precisely — they forward MARKS. A mark emitted in tab A is
serialized, sent, and `ingest()`-ed into tab B's tape (S10.3), so tab B's
`on(…, { replay: true })`, `memory`, and analytics taps see it. What they do
**not** do is merge tab A's and tab B's MEDIATION REGISTRIES. `handle` and
`dispatch` are per-runtime (S15.1) — dispatching in tab B for a handler
registered only in tab A still hits `no-handler`, transport connected or not.
The transports solve *observation* across realms; they were never built to
solve *invocation* across realms, and bolting dispatch onto them would be the
transport quietly growing a remote-procedure-call layer telic's initiative
boundary forbids (DESIGN.md — telic never owns transport).

Cross-realm dispatch — actually invoking a handler that lives in another
tab, iframe, or worker — is tracked as open design work, not shipped
behavior: see [docs/design/cross-realm-dispatch.md](../design/cross-realm-dispatch.md)
(being drafted alongside this recipe) and
[PROPOSALS.md PR-2](../../PROPOSALS.md). Until that lands, the honest
guidance is: if a capability needs to be INVOKED from another realm, not just
observed, that invocation is the app's problem to wire (a `MessagePort` RPC,
a Comlink proxy — see [COMPARISON.md](../../COMPARISON.md)'s Comlink
section) — telic will record and forward the marks either side produces, but
it will not make the call for you.
