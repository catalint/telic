import { describe, expect, it } from "bun:test";
import type { AttemptId, Mark, Runtime } from "../core.js";
import { createRuntime } from "../core.js";
import { createConsoleTap } from "./console.js";

// ---------------------------------------------------------------------------
// Test infrastructure (no external deps; taps run against a REAL runtime).
// ---------------------------------------------------------------------------

function makeRuntime(): { rt: Runtime } {
	let counter = 0;
	const rt = createRuntime({
		now: () => 1000,
		id: () => {
			counter += 1;
			return `att-${counter}`;
		},
	});
	return { rt };
}

function idStr(id: AttemptId): string {
	return id;
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

// ---------------------------------------------------------------------------
// S13.1: Console tap
// ---------------------------------------------------------------------------

describe("S13.1: console tap", () => {
	it("S13.1: given an injected log, when marks occur, then each yields a `kind intent#attemptShort` line", () => {
		const { rt } = makeRuntime();
		const lines: string[] = [];
		rt.tap(createConsoleTap({ log: (line) => lines.push(line) }));
		const attempt = rt.intent("cart.checkout").begin();
		attempt.fulfill();
		const short = idStr(attempt.id).slice(0, 8);
		expect(lines.length).toBe(2);
		expect(at(lines, 0)).toBe(`begun cart.checkout#${short}`);
		expect(at(lines, 1)).toBe(`fulfilled cart.checkout#${short}`);
	});

	it("S13.1: given an injected log, when a mark occurs, then the mark is passed alongside the line", () => {
		const { rt } = makeRuntime();
		const captured: Mark[] = [];
		rt.tap(createConsoleTap({ log: (_line, mark) => captured.push(mark) }));
		rt.intent("op.run").begin();
		expect(only(captured).kind).toBe("begun");
	});

	it("S13.1: given rejected and abandoned marks, when logged, then the line carries the kind-specific detail", () => {
		const { rt } = makeRuntime();
		const lines: string[] = [];
		rt.tap(createConsoleTap({ log: (line) => lines.push(line) }));
		const failing = rt.intent("op.risky").begin();
		failing.reject("boom");
		const dropped = rt.intent("upload.file").begin();
		dropped.abandon({ why: "timeout" });
		expect(lines.some((line) => line.includes("✗ boom"))).toBe(true);
		expect(lines.some((line) => line.includes("(timeout)"))).toBe(true);
	});

	it("S13.1: given no global console, when the default log runs, then onMark never throws", () => {
		const globalRef: { console: unknown } = globalThis;
		const original = globalThis.console;
		globalRef.console = undefined;
		try {
			const { rt } = makeRuntime();
			rt.tap(createConsoleTap());
			expect(() => rt.intent("a.b").begin()).not.toThrow();
		} finally {
			globalRef.console = original;
		}
	});
});
