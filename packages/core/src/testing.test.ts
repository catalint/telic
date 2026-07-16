import { describe, expect, it } from "bun:test";
import type { StandardSchemaV1 } from "./standard-schema.js";
import {
	attemptsOf,
	createTestRuntime,
	marksOf,
	phaseOf,
	serializeTape,
} from "./testing.js";
import type { AttemptId, Runtime } from "./types.js";

// ---------------------------------------------------------------------------
// Test infrastructure.
// ---------------------------------------------------------------------------

function passthroughSchema(): StandardSchemaV1<unknown, unknown> {
	return {
		"~standard": {
			version: 1,
			vendor: "telic-test",
			validate: (value) => ({ value }),
		},
	};
}

// Sanctioned overload-brand bridge (no `as`) to mint a non-existent id.
function asAttemptId(value: string): AttemptId;
function asAttemptId(value: string): string {
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKeysSortedDeep(value: unknown): void {
	if (Array.isArray(value)) {
		for (const item of value) assertKeysSortedDeep(item);
		return;
	}
	if (isRecord(value)) {
		const keys = Object.keys(value);
		expect(keys).toEqual([...keys].sort());
		for (const key of keys) assertKeysSortedDeep(value[key]);
	}
}

function driveTape(runtime: Runtime): void {
	const checkout = runtime.intent("cart.checkout", {
		payload: passthroughSchema(),
	});
	const attempt = checkout.begin({ items: 2 });
	attempt.note({ step: "review" });
	attempt.link({ kind: "manual", label: "audit", data: { z: 1, a: 2 } });
	attempt.fulfill();
	runtime.intent("beat.ping").begin();
}

describe("S21 testing subpath", () => {
	it("S21.2: determinism — two runtimes, same ops, identical serializeTape", () => {
		const one = createTestRuntime();
		const two = createTestRuntime();
		driveTape(one.runtime);
		driveTape(two.runtime);
		expect(serializeTape(one.runtime)).toBe(serializeTape(two.runtime));
	});

	it("S21.2: clock start is 1000; advance/set reflected in mark.at", () => {
		const { runtime, clock } = createTestRuntime();
		expect(clock.now()).toBe(1000);
		const checkout = runtime.intent("cart.checkout", {
			payload: passthroughSchema(),
		});
		const attempt = checkout.begin({ x: 1 }); // at 1000
		clock.advance(50);
		attempt.fulfill(); // at 1050
		clock.set(9000);
		runtime.intent("beat.ping").begin(); // at 9000

		expect(marksOf(runtime).map((mark) => mark.at)).toEqual([1000, 1050, 9000]);
	});

	it("S21.2: nextId is the deterministic counter source (t1, t2, …)", () => {
		const { nextId } = createTestRuntime();
		expect([nextId(), nextId(), nextId()]).toEqual(["t1", "t2", "t3"]);
	});

	it("S21.3: helpers filter correctly", () => {
		const { runtime } = createTestRuntime();
		const cart = runtime.intent("cart.checkout", {
			payload: passthroughSchema(),
		});
		const attempt = cart.begin({ x: 1 });
		attempt.fulfill();
		runtime.intent("beat.ping").begin();

		expect(
			marksOf(runtime, "cart.*").every(
				(mark) => mark.intent === "cart.checkout",
			),
		).toBe(true);
		expect(attemptsOf(runtime, "beat.*").map((view) => view.intent)).toEqual([
			"beat.ping",
		]);
		expect(phaseOf(runtime, attempt.id)?.phase).toBe("fulfilled");
		expect(phaseOf(runtime, asAttemptId("does-not-exist"))).toBeUndefined();
	});

	it("S21.3: serializeTape emits sorted keys at every depth (insertion-independent)", () => {
		const { runtime } = createTestRuntime();
		driveTape(runtime);
		const parsed: unknown = JSON.parse(serializeTape(runtime));
		expect(Array.isArray(parsed)).toBe(true);
		assertKeysSortedDeep(parsed);
	});
});
