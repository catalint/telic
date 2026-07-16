/**
 * Subpath floor-coverage barrel (D19d): a type-only re-export of EVERY published
 * @telic/core subpath, so run.ts's per-version `tsc` parses each subpath's
 * emitted `.d.ts` under the whole support floor — not just the three subpaths
 * consumer.ts happens to import. A `.d.ts` using syntax newer than the floor
 * TypeScript can parse fails here rather than in a real TS 5.5 consumer.
 *
 * `export type * as <ns>` is type-only (no runtime binding) and namespaced (no
 * cross-subpath name collisions); loading each namespace forces tsc to load and
 * parse that subpath's declaration file. Keep this in sync with package.json
 * `exports` — the conventions-gate asserts exports↔size-budget parity, and this
 * list should carry one entry per published subpath.
 */
export type * as core from "@telic/core";
export type * as tapsConsole from "@telic/core/taps/console";
export type * as tapsBreadcrumbs from "@telic/core/taps/breadcrumbs";
export type * as tapsSentry from "@telic/core/taps/sentry";
export type * as tapsUserTiming from "@telic/core/taps/user-timing";
export type * as tapsAnalytics from "@telic/core/taps/analytics";
export type * as agent from "@telic/core/agent";
export type * as mediate from "@telic/core/mediate";
export type * as flow from "@telic/core/flow";
export type * as persist from "@telic/core/persist";
export type * as wire from "@telic/core/wire";
export type * as testing from "@telic/core/testing";
export type * as adaptersTanstackQuery from "@telic/core/adapters/tanstack-query";
export type * as transportsBroadcast from "@telic/core/transports/broadcast";
export type * as transportsPostMessage from "@telic/core/transports/post-message";
export type * as transportsSharedWorker from "@telic/core/transports/shared-worker";
export type * as adaptersXstate from "@telic/core/adapters/xstate";
export type * as devtools from "@telic/core/devtools";
export type * as tapsOtel from "@telic/core/taps/otel";
