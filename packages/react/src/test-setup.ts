/**
 * Test environment bootstrap (NOT shipped — excluded from tsconfig.build).
 *
 * Renderer stack choice: happy-dom (GlobalRegistrator) + react-dom/client +
 * React 19's `act`, driven directly under plain `bun test` — no
 * @testing-library layer, no vitest/jsdom. Rationale: the specs assert
 * registration counts, mark tapes, and reference identities rather than DOM
 * queries, so a ~40-line createRoot harness (test-harness.tsx) is sufficient,
 * deterministic, and keeps the dev-dependency surface minimal. bun test runs
 * with NODE_ENV=test, which resolves React's DEV builds — required for the
 * StrictMode double-mount contract tests (R2.3, R3.2); each of those tests
 * also asserts the double-mount actually happened.
 *
 * This module is imported FIRST by test-harness.tsx (and transitively by every
 * test file) so DOM globals exist before react-dom initializes.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

declare global {
	// React's act() gate; react-dom checks this flag in DEV.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

if (typeof document === "undefined") {
	GlobalRegistrator.register();
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
