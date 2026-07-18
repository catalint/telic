import { describe, expect, it } from "bun:test";
import type { Mark, Runtime } from "../core.js";
import { createRuntime } from "../core.js";
import type { AgentSurface } from "./surface.js";
import { exposeAgentSurface } from "./surface.js";

// ---------------------------------------------------------------------------
// Test infrastructure (no external deps; duplicated per file by design)
// ---------------------------------------------------------------------------

const DEFAULT_KEY = "__INTENT_MEMORY__";

/** Fresh, fully-injected runtime per test: deterministic clock + ids. */
function makeRuntime(): Runtime {
	const clock = { t: 1000 };
	let counter = 0;
	return createRuntime({
		now: () => clock.t,
		id: () => {
			counter += 1;
			return `a${counter}`;
		},
	});
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

/** Overload bridge (house style, see core.ts) — no `as` casts anywhere. */
function asAgentSurface(value: unknown): AgentSurface;
function asAgentSurface(value: unknown): unknown {
	return value;
}

/** Reads back the slot this suite just installed — always an explicit plain object, never globalThis. */
function readFacade(target: object, key: string = DEFAULT_KEY): AgentSurface {
	const value = Reflect.get(target, key);
	if (value === undefined) throw new Error(`nothing installed at ${key}`);
	return asAgentSurface(value);
}

// ---------------------------------------------------------------------------
// S14.1/S14.2: facade shape
// ---------------------------------------------------------------------------

describe("S14.1/S14.2: facade shape", () => {
	it('S14.1: given a runtime, when exposeAgentSurface installs with no opts, then the facade lands at target["__INTENT_MEMORY__"]', () => {
		const rt = makeRuntime();
		const target = {};
		exposeAgentSurface(rt, { target });
		expect(Reflect.has(target, DEFAULT_KEY)).toBe(true);
	});

	it("S14.1: given an explicit key, when exposeAgentSurface installs, then the facade lands at that key instead of the default", () => {
		const rt = makeRuntime();
		const target = {};
		exposeAgentSurface(rt, { target, key: "myAgentHook" });
		expect(Reflect.has(target, "myAgentHook")).toBe(true);
		expect(Reflect.has(target, DEFAULT_KEY)).toBe(false);
	});

	it("S14.1/S14.2: given an installed facade, then it has version 1 and the four delegation methods, and is frozen", () => {
		const rt = makeRuntime();
		const target = {};
		exposeAgentSurface(rt, { target });
		const facade = readFacade(target);

		expect(facade.version).toBe(1);
		expect(typeof facade.snapshot).toBe("function");
		expect(typeof facade.marks).toBe("function");
		expect(typeof facade.inProgress).toBe("function");
		expect(typeof facade.describe).toBe("function");
		expect(Object.isFrozen(facade)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// S14.2: delegation correctness
// ---------------------------------------------------------------------------

describe("S14.2: delegation correctness", () => {
	it("S14.2: given a declared intent, when snapshot() is called on the facade, then it delegates to memory.snapshot()", () => {
		const rt = makeRuntime();
		const target = {};
		exposeAgentSurface(rt, { target });
		const facade = readFacade(target);

		const publicFlow = rt.intent("agent.publicThing");
		publicFlow.begin();

		const snap = facade.snapshot();
		expect(snap).toEqual(rt.memory.snapshot());
		expect(snap.active.some((view) => view.intent === "agent.publicThing")).toBe(true);
	});

	it("S14.2/S6.5: given several begun marks, when marks(sinceSeq) is called on the facade, then it delegates to memory.marks({ sinceSeq }) with sinceSeq EXCLUSIVE", () => {
		const rt = makeRuntime();
		const target = {};
		exposeAgentSurface(rt, { target });
		const facade = readFacade(target);

		const flow = rt.intent("agent.thing");
		flow.begin();
		const firstMark: Mark = only(rt.memory.marks());
		flow.begin();
		flow.begin();

		const all = facade.marks();
		expect(all.length).toBe(3);
		expect(all).toEqual(rt.memory.marks());

		const sinceFirst = facade.marks(firstMark.seq);
		expect(sinceFirst.length).toBe(2);
		expect(sinceFirst.every((mark) => mark.seq > firstMark.seq)).toBe(true);
		expect(sinceFirst).toEqual(rt.memory.marks({ sinceSeq: firstMark.seq }));

		// No sinceSeq behaves like "no filter" — the full retained tape.
		expect(facade.marks(undefined)).toEqual(all);
	});

	it("S14.2: given an active and a settled attempt, when inProgress() is called on the facade, then it delegates to memory.inProgress() (active only)", () => {
		const rt = makeRuntime();
		const target = {};
		exposeAgentSurface(rt, { target });
		const facade = readFacade(target);

		const activeFlow = rt.intent("agent.active");
		const settledFlow = rt.intent("agent.settled");
		activeFlow.begin();
		const settledAttempt = settledFlow.begin();
		settledAttempt.fulfill();

		const inProgress = facade.inProgress();
		expect(inProgress).toEqual(rt.memory.inProgress());
		expect(inProgress.some((view) => view.intent === "agent.active")).toBe(true);
		expect(inProgress.some((view) => view.intent === "agent.settled")).toBe(false);
	});

	it("S14.2/S12.1: given declared intents (incl. a re-declaration), when describe() is called on the facade, then it delegates to runtime.describe() verbatim", () => {
		const rt = makeRuntime();
		const target = {};
		exposeAgentSurface(rt, { target });
		const facade = readFacade(target);

		rt.intent("agent.one", { tags: ["funnel"] });
		rt.intent("agent.two", { tags: ["ops"] });
		rt.intent("agent.one"); // re-declaration must not duplicate the descriptor (S12.1)

		const described = facade.describe();
		expect(described).toEqual(rt.describe());
		expect(described.length).toBe(2);
	});

	it("S14.2/S12.6: given an intent declared with an agent descriptor, when describe() is called on the facade, then the agent field flows through verbatim (by reference)", () => {
		const rt = makeRuntime();
		const target = {};
		exposeAgentSurface(rt, { target });
		const facade = readFacade(target);

		const inputShape = { type: "object", properties: { sku: { type: "string" } } };
		rt.intent("agent.addItem", { agent: { summary: "Add a SKU", input: inputShape } });

		const described = facade.describe();
		expect(described).toEqual(rt.describe());
		const descriptor = only(described.filter((entry) => entry.name === "agent.addItem"));
		expect(descriptor.agent).toEqual({ summary: "Add a SKU", input: inputShape });
		expect(descriptor.agent?.input).toBe(inputShape);
	});
});

// ---------------------------------------------------------------------------
// S14.3: install-over-existing semantics + uninstall ownership
// ---------------------------------------------------------------------------

describe("S14.3: install-over-existing + uninstall ownership", () => {
	it("S14.3: given a non-facade value already at the slot, when exposeAgentSurface installs, then it is left untouched and uninstall is a no-op", () => {
		const rt = makeRuntime();
		const target = { [DEFAULT_KEY]: "someone-else's-value" };

		const uninstall = exposeAgentSurface(rt, { target });
		expect(Reflect.get(target, DEFAULT_KEY)).toBe("someone-else's-value");

		uninstall();
		expect(Reflect.get(target, DEFAULT_KEY)).toBe("someone-else's-value");
	});

	it("S14.3: given a previous telic facade already at the slot, when exposeAgentSurface installs again, then it overwrites silently", () => {
		const rtA = makeRuntime();
		const rtB = makeRuntime();
		const target = {};

		exposeAgentSurface(rtA, { target });
		const facadeA = readFacade(target);

		exposeAgentSurface(rtB, { target });
		const facadeB = readFacade(target);

		expect(facadeB).not.toBe(facadeA);

		rtB.intent("agent.onlyOnB");
		expect(facadeB.describe().some((entry) => entry.name === "agent.onlyOnB")).toBe(true);
		expect(facadeA.describe().some((entry) => entry.name === "agent.onlyOnB")).toBe(false);
	});

	it("S14.3: given install A then install B over it, when A's uninstaller runs, then it no-ops and B stays installed", () => {
		const rtA = makeRuntime();
		const rtB = makeRuntime();
		const target = {};

		const uninstallA = exposeAgentSurface(rtA, { target });
		const facadeA = readFacade(target);

		const uninstallB = exposeAgentSurface(rtB, { target });
		const facadeB = readFacade(target);
		expect(facadeB).not.toBe(facadeA);

		uninstallA();
		expect(readFacade(target)).toBe(facadeB);

		uninstallB();
		expect(Reflect.has(target, DEFAULT_KEY)).toBe(false);
	});
});
