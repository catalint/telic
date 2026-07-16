import { describe, expect, it } from "bun:test";
import type { AttemptView, Diagnostic, Mark, Runtime } from "../core";
import { createRuntime } from "../core";
import type { AnalyticsDedupe, AnalyticsEvent } from "./analytics";
import { createAnalyticsTap } from "./analytics";

// ---------------------------------------------------------------------------
// Test infrastructure (no external deps; the tap runs against a REAL runtime,
// driven through declared intents).
// ---------------------------------------------------------------------------

function makeRuntime(): { rt: Runtime; diagnostics: Diagnostic[] } {
	const diagnostics: Diagnostic[] = [];
	let counter = 0;
	const rt = createRuntime({
		now: () => 1000,
		id: () => {
			counter += 1;
			return `att-${counter}`;
		},
		onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
	});
	return { rt, diagnostics };
}

type EmitCapture = { readonly mark: Mark; readonly view: AttemptView | undefined };

function makeDedupe(seed: readonly string[] = []): {
	adapter: AnalyticsDedupe;
	saved: string[][];
} {
	const saved: string[][] = [];
	let store: readonly string[] = seed;
	const adapter: AnalyticsDedupe = {
		load: (): readonly string[] => store,
		save: (keys): void => {
			store = keys;
			saved.push([...keys]);
		},
	};
	return { adapter, saved };
}

function at<T>(items: readonly T[], index: number): T {
	const item = items[index];
	if (item === undefined) throw new Error(`no element at index ${index}`);
	return item;
}

function only<T>(items: readonly T[]): T {
	if (items.length !== 1) throw new Error(`expected exactly one element, got ${items.length}`);
	return at(items, 0);
}

function last<T>(items: readonly T[]): T {
	if (items.length === 0) throw new Error("expected at least one element");
	return at(items, items.length - 1);
}

function tapErrors(diagnostics: readonly Diagnostic[]): readonly Diagnostic[] {
	return diagnostics.filter((diagnostic) => diagnostic.code === "tap-error");
}

// ---------------------------------------------------------------------------
// S17.1/S17.2: rule matching + map/emit
// ---------------------------------------------------------------------------

describe("S17.2: rule matching", () => {
	it("S17.2: given a scope-wildcard rule, when a matching begun mark occurs, then map's event is sent", () => {
		const { rt } = makeRuntime();
		const sent: AnalyticsEvent[] = [];
		rt.tap(
			createAnalyticsTap({
				send: (event) => sent.push(event),
				consent: () => true,
				rules: [
					{
						on: "cart.*",
						kind: "begun",
						map: (mark, view) => ({
							name: "checkout_started",
							props: { intent: mark.intent, phase: view?.phase ?? "none" },
						}),
					},
				],
			}),
		);
		rt.intent("cart.checkout").begin();
		const event = only(sent);
		expect(event.name).toBe("checkout_started");
		expect(event.props).toEqual({ intent: "cart.checkout", phase: "active" });
	});

	it("S17.2: given a rule for a different kind, when a begun mark occurs, then nothing is sent", () => {
		const { rt } = makeRuntime();
		const sent: AnalyticsEvent[] = [];
		rt.tap(
			createAnalyticsTap({
				send: (event) => sent.push(event),
				consent: () => true,
				rules: [{ on: "cart.checkout", kind: "fulfilled", map: () => ({ name: "done" }) }],
			}),
		);
		const attempt = rt.intent("cart.checkout").begin();
		expect(sent).toHaveLength(0);
		attempt.fulfill();
		expect(only(sent).name).toBe("done");
	});

	it("S17.2: given a non-matching pattern, when a mark occurs, then nothing is sent", () => {
		const { rt } = makeRuntime();
		const sent: AnalyticsEvent[] = [];
		rt.tap(
			createAnalyticsTap({
				send: (event) => sent.push(event),
				consent: () => true,
				rules: [{ on: "cart.checkout", kind: "begun", map: () => ({ name: "c" }) }],
			}),
		);
		rt.intent("user.login").begin();
		expect(sent).toHaveLength(0);
	});

	it("S17.2: given a when guard returning false, when a mark occurs, then the rule does not fire", () => {
		const { rt } = makeRuntime();
		const sent: AnalyticsEvent[] = [];
		let allow = false;
		rt.tap(
			createAnalyticsTap({
				send: (event) => sent.push(event),
				consent: () => true,
				rules: [
					{ on: "cart.checkout", kind: "begun", when: () => allow, map: () => ({ name: "c" }) },
				],
			}),
		);
		rt.intent("cart.checkout").begin();
		expect(sent).toHaveLength(0);
		allow = true;
		rt.intent("cart.checkout").begin();
		expect(only(sent).name).toBe("c");
	});

	it("S17.2: given a rule with only emit, when a mark occurs, then emit runs with mark and view and send is untouched", () => {
		const { rt } = makeRuntime();
		const sent: AnalyticsEvent[] = [];
		const emitted: EmitCapture[] = [];
		rt.tap(
			createAnalyticsTap({
				send: (event) => sent.push(event),
				consent: () => true,
				rules: [
					{
						on: "cart.checkout",
						kind: "begun",
						emit: (mark, view) => emitted.push({ mark, view }),
					},
				],
			}),
		);
		rt.intent("cart.checkout").begin();
		expect(sent).toHaveLength(0);
		const capture = only(emitted);
		expect(capture.mark.intent).toBe("cart.checkout");
		expect(capture.view?.phase).toBe("active");
	});

	it("S17.2: given both map and emit, when gated once per-intent, then both fire together once and share the key", () => {
		const { rt } = makeRuntime();
		const sent: AnalyticsEvent[] = [];
		const emitted: EmitCapture[] = [];
		rt.tap(
			createAnalyticsTap({
				send: (event) => sent.push(event),
				consent: () => true,
				rules: [
					{
						on: "cart.checkout",
						kind: "begun",
						once: "per-intent",
						map: () => ({ name: "c" }),
						emit: (mark, view) => emitted.push({ mark, view }),
					},
				],
			}),
		);
		rt.intent("cart.checkout").begin();
		rt.intent("cart.checkout").begin();
		expect(sent).toHaveLength(1);
		expect(emitted).toHaveLength(1);
	});

	it("S17.2: given a rule with neither map nor emit, when constructed, then it throws a TypeError", () => {
		expect(() =>
			createAnalyticsTap({
				send: () => {},
				consent: () => true,
				rules: [{ on: "cart.checkout", kind: "begun" }],
			}),
		).toThrow(TypeError);
	});
});

// ---------------------------------------------------------------------------
// S17.3: once semantics
// ---------------------------------------------------------------------------

describe("S17.3: once", () => {
	it("S17.3: given once per-intent, when several matching marks occur, then the rule fires exactly once", () => {
		const { rt } = makeRuntime();
		const sent: AnalyticsEvent[] = [];
		rt.tap(
			createAnalyticsTap({
				send: (event) => sent.push(event),
				consent: () => true,
				rules: [
					{ on: "cart.checkout", kind: "begun", once: "per-intent", map: () => ({ name: "c" }) },
				],
			}),
		);
		rt.intent("cart.checkout").begin();
		rt.intent("cart.checkout").begin();
		rt.intent("cart.checkout").begin();
		expect(sent).toHaveLength(1);
	});

	it("S17.3: given a dedupe adapter seeded with the derived key, when a matching mark occurs, then the rule is suppressed", () => {
		const { rt } = makeRuntime();
		const sent: AnalyticsEvent[] = [];
		const { adapter } = makeDedupe(["cart.checkout|begun"]);
		rt.tap(
			createAnalyticsTap({
				send: (event) => sent.push(event),
				consent: () => true,
				dedupe: adapter,
				rules: [
					{ on: "cart.checkout", kind: "begun", once: "per-intent", map: () => ({ name: "c" }) },
				],
			}),
		);
		rt.intent("cart.checkout").begin();
		expect(sent).toHaveLength(0);
	});

	it("S17.3: given per-intent rules firing across intents, then save receives the cumulative key list", () => {
		const { rt } = makeRuntime();
		const { adapter, saved } = makeDedupe();
		rt.tap(
			createAnalyticsTap({
				send: () => {},
				consent: () => true,
				dedupe: adapter,
				rules: [
					{
						on: "cart.checkout",
						kind: "begun",
						once: "per-intent",
						onceKey: "a",
						map: () => ({ name: "c" }),
					},
					{
						on: "user.login",
						kind: "begun",
						once: "per-intent",
						onceKey: "b",
						map: () => ({ name: "l" }),
					},
				],
			}),
		);
		rt.intent("cart.checkout").begin();
		rt.intent("user.login").begin();
		expect(saved).toEqual([["a"], ["a", "b"]]);
	});

	it("S17.3: given an onceKey override, when persisted, then the key is used verbatim", () => {
		const { rt } = makeRuntime();
		const { adapter, saved } = makeDedupe();
		rt.tap(
			createAnalyticsTap({
				send: () => {},
				consent: () => true,
				dedupe: adapter,
				rules: [
					{
						on: "cart.checkout",
						kind: "fulfilled",
						once: "per-intent",
						onceKey: "signup_done",
						map: () => ({ name: "done" }),
					},
				],
			}),
		);
		rt.intent("cart.checkout").begin().fulfill();
		expect(last(saved)).toEqual(["signup_done"]);
	});

	it("S17.3: given once per-attempt, when marks repeat within one attempt, then it fires once per attempt but refires for a new one", () => {
		const { rt } = makeRuntime();
		const sent: AnalyticsEvent[] = [];
		const { adapter, saved } = makeDedupe();
		rt.tap(
			createAnalyticsTap({
				send: (event) => sent.push(event),
				consent: () => true,
				dedupe: adapter,
				rules: [
					{
						on: "wizard.step",
						kind: "noted",
						once: "per-attempt",
						map: (mark) => ({ name: "step", props: { id: mark.attempt } }),
					},
				],
			}),
		);
		const first = rt.intent("wizard.step").begin();
		first.note({ step: 1 });
		first.note({ step: 2 });
		const second = rt.intent("wizard.step").begin();
		second.note({ step: 1 });
		expect(sent).toHaveLength(2);
		expect(at(sent, 0).props).toEqual({ id: "att-1" });
		expect(at(sent, 1).props).toEqual({ id: "att-2" });
		// per-attempt keys are never persisted (S17.3).
		expect(saved).toHaveLength(0);
	});

	it("S17.3: given a when guard that returns false, then the once-key is not consumed", () => {
		const { rt } = makeRuntime();
		const sent: AnalyticsEvent[] = [];
		let allow = false;
		rt.tap(
			createAnalyticsTap({
				send: (event) => sent.push(event),
				consent: () => true,
				rules: [
					{
						on: "cart.checkout",
						kind: "begun",
						once: "per-intent",
						when: () => allow,
						map: () => ({ name: "c" }),
					},
				],
			}),
		);
		rt.intent("cart.checkout").begin();
		expect(sent).toHaveLength(0);
		allow = true;
		rt.intent("cart.checkout").begin();
		expect(sent).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// S17.4: consent gating + buffering
// ---------------------------------------------------------------------------

describe("S17.4: consent", () => {
	it("S17.4: given consent denied and the default drop mode, when a mark matches, then nothing is sent even after recheck", () => {
		const { rt } = makeRuntime();
		const sent: AnalyticsEvent[] = [];
		const tap = createAnalyticsTap({
			send: (event) => sent.push(event),
			consent: () => false,
			rules: [{ on: "cart.checkout", kind: "begun", map: () => ({ name: "c" }) }],
		});
		rt.tap(tap);
		rt.intent("cart.checkout").begin();
		expect(sent).toHaveLength(0);
		tap.recheck();
		expect(sent).toHaveLength(0);
	});

	it("S17.4: given consent denied and both map and emit, when dropped, then neither send nor emit runs", () => {
		const { rt } = makeRuntime();
		const sent: AnalyticsEvent[] = [];
		const emitted: EmitCapture[] = [];
		rt.tap(
			createAnalyticsTap({
				send: (event) => sent.push(event),
				consent: () => false,
				rules: [
					{
						on: "cart.checkout",
						kind: "begun",
						map: () => ({ name: "c" }),
						emit: (mark, view) => emitted.push({ mark, view }),
					},
				],
			}),
		);
		rt.intent("cart.checkout").begin();
		expect(sent).toHaveLength(0);
		expect(emitted).toHaveLength(0);
	});

	it("S17.4: given buffer mode and denied consent, when recheck runs with consent granted, then buffered actions flush FIFO", () => {
		const { rt } = makeRuntime();
		const sent: AnalyticsEvent[] = [];
		let allow = false;
		const tap = createAnalyticsTap({
			send: (event) => sent.push(event),
			consent: () => allow,
			whileDenied: "buffer",
			rules: [
				{
					on: "cart.*",
					kind: "begun",
					map: (mark) => ({ name: "c", props: { id: mark.attempt } }),
				},
			],
		});
		rt.tap(tap);
		rt.intent("cart.checkout").begin();
		rt.intent("cart.checkout").begin();
		rt.intent("cart.checkout").begin();
		expect(sent).toHaveLength(0);
		allow = true;
		tap.recheck();
		expect(sent.map((event) => event.props?.id)).toEqual(["att-1", "att-2", "att-3"]);
	});

	it("S17.4: given a buffered action whose key a live mark consumes meanwhile, when flushed, then the stale action is discarded", () => {
		const { rt } = makeRuntime();
		const sent: AnalyticsEvent[] = [];
		let allow = false;
		const tap = createAnalyticsTap({
			send: (event) => sent.push(event),
			consent: () => allow,
			whileDenied: "buffer",
			rules: [
				{
					on: "cart.checkout",
					kind: "begun",
					once: "per-intent",
					map: (mark) => ({ name: "c", props: { id: mark.attempt } }),
				},
			],
		});
		rt.tap(tap);
		rt.intent("cart.checkout").begin(); // att-1 buffered, key not yet consumed
		allow = true;
		rt.intent("cart.checkout").begin(); // att-2 fires live, consumes the key
		tap.recheck(); // att-1 discarded — key already consumed
		expect(sent.map((event) => event.props?.id)).toEqual(["att-2"]);
	});

	it("S17.4: given buffer mode and more than 50 denied marks, when flushed, then only the last 50 survive (oldest dropped)", () => {
		const { rt } = makeRuntime();
		const sent: AnalyticsEvent[] = [];
		let allow = false;
		const tap = createAnalyticsTap({
			send: (event) => sent.push(event),
			consent: () => allow,
			whileDenied: "buffer",
			rules: [
				{
					on: "cart.checkout",
					kind: "begun",
					map: (mark) => ({ name: "c", props: { id: mark.attempt } }),
				},
			],
		});
		rt.tap(tap);
		for (let index = 0; index < 55; index += 1) rt.intent("cart.checkout").begin();
		allow = true;
		tap.recheck();
		expect(sent).toHaveLength(50);
		expect(at(sent, 0).props).toEqual({ id: "att-6" });
		expect(last(sent).props).toEqual({ id: "att-55" });
	});
});

// ---------------------------------------------------------------------------
// S17.5 / S17.6: no replay, callbacks propagate
// ---------------------------------------------------------------------------

describe("S17.5: no onAttach replay", () => {
	it("S17.5: given a mark before attach, when the tap attaches, then only marks after attach are sent", () => {
		const { rt } = makeRuntime();
		const sent: AnalyticsEvent[] = [];
		rt.intent("cart.checkout").begin();
		rt.tap(
			createAnalyticsTap({
				send: (event) => sent.push(event),
				consent: () => true,
				rules: [{ on: "cart.checkout", kind: "begun", map: () => ({ name: "c" }) }],
			}),
		);
		expect(sent).toHaveLength(0);
		rt.intent("cart.checkout").begin();
		expect(sent).toHaveLength(1);
	});
});

describe("S17.6: callbacks propagate", () => {
	it("S17.6: given a throwing map, when a mark occurs, then core records a tap-error and later taps and listeners still run", () => {
		const { rt, diagnostics } = makeRuntime();
		const spyMarks: Mark[] = [];
		let listenerRan = false;
		rt.tap(
			createAnalyticsTap({
				send: () => {},
				consent: () => true,
				rules: [
					{
						on: "cart.checkout",
						kind: "begun",
						map: () => {
							throw new Error("boom");
						},
					},
				],
			}),
		);
		rt.tap({ id: "spy", onMark: (mark) => spyMarks.push(mark) });
		rt.on("*", () => {
			listenerRan = true;
		});
		rt.intent("cart.checkout").begin();
		expect(tapErrors(diagnostics)).toHaveLength(1);
		expect(at(tapErrors(diagnostics), 0).code).toBe("tap-error");
		expect(spyMarks).toHaveLength(1);
		expect(listenerRan).toBe(true);
	});
});
