# Examples

Examples are complete, worked use cases — start to a working result, both
sides of a boundary when there are two. They're a different altitude than the
other docs in this package: [Recipes](../recipes/) wire a specific vendor or
bundler setup (PostHog, Module Federation) against telic's stable surface;
[PATTERNS.md](../../PATTERNS.md) is the rulebook — the patterns (P1–P12) and
anti-patterns (AP1–AP9) every example below is written to obey, not to
duplicate. If you haven't read PATTERNS yet, start there; these are what
following it looks like end to end, in one sitting, with both sides of the
wire shown.

| Example | When this is your situation |
|---|---|
| [Cross-realm dispatch: a support widget](./support-widget-cross-realm.md) | A capability lives in a different realm — a cross-origin iframe, a separately-deployed app — and you need to *invoke* it, not just observe its marks |
| [Worker offload](./worker-offload.md) | A handler runs off the main thread, in a Web Worker, and the main thread needs to dispatch to it and watch its progress without blocking |
| [Checkout flow: a same-realm saga](./checkout-flow.md) | A multi-step process must survive a reload mid-flight and never re-run a step (or double-charge) that already committed |

The first two exercise `@telic/core/transports/remote-dispatch` (SPEC S28) —
new machinery, landing alongside this folder. Every signature in those two
examples is taken verbatim from the spec; where the [design
doc](../design/cross-realm-dispatch.md) that argued for this shape used
illustrative names, this folder uses the names S28 actually settled on. The
third example is same-realm and pre-dates all of that — it's here so the
folder isn't only about the newest feature.
