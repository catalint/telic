import { describe, expect, it } from "bun:test";
import { createRuntime } from "../core.js";
import { createBreadcrumbTap } from "./breadcrumbs.js";
import type { BreadcrumbLike, BreadcrumbTapOptions, IntentContext } from "./sentry.js";
import { createSentryBreadcrumbTap, intentContext } from "./sentry.js";

// ---------------------------------------------------------------------------
// S13.2: taps/sentry is a thin preset over taps/breadcrumbs. The full behavioral
// suite lives in breadcrumbs.test.ts; here we only pin the alias identity and
// the re-export surface existing consumers (apps/web) rely on.
// ---------------------------------------------------------------------------

describe("S13.2: sentry preset", () => {
	it("S13.2: given the preset, then createSentryBreadcrumbTap is the SAME function as createBreadcrumbTap", () => {
		expect(createSentryBreadcrumbTap).toBe(createBreadcrumbTap);
	});

	it("S13.2: given the preset, then intentContext is re-exported and delegates to memory", () => {
		const rt = createRuntime({ now: () => 2500, id: () => "att-1" });
		rt.intent("nav.step").begin();
		const context: IntentContext = intentContext(rt.memory);
		expect(context.inProgress.length).toBe(1);
		expect(context.recent.length).toBe(1);
	});

	it("S13.2: given the preset, then the tap type surface is importable and structurally usable", () => {
		const crumbs: BreadcrumbLike[] = [];
		const opts: BreadcrumbTapOptions = { addBreadcrumb: (crumb) => crumbs.push(crumb) };
		const rt = createRuntime({ now: () => 1000, id: () => "att-2" });
		rt.tap(createSentryBreadcrumbTap(opts));
		rt.intent("cart.checkout").begin();
		expect(crumbs.length).toBe(1);
		expect(crumbs[0]?.message).toBe("begun cart.checkout");
	});
});
