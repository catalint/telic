import { describe, expect, it } from "bun:test";
import type { StorageLike } from "./persist.js";
import { clearPersistedTape, connectStorage } from "./persist.js";
import type { StandardSchemaV1 } from "./standard-schema.js";
import { createTestRuntime, marksOf, phaseOf } from "./testing.js";
import type { Mark } from "./types.js";
import { parseWirePayload } from "./wire.js";

// ---------------------------------------------------------------------------
// Test infrastructure — Map-backed, failure-injectable structural storage.
// ---------------------------------------------------------------------------

type FakeStorage = {
	readonly storage: StorageLike;
	readonly data: Map<string, string>;
	readonly counts: { reads: number; writes: number; removes: number };
	setFailWrites(fail: boolean): void;
};

function makeFakeStorage(): FakeStorage {
	const data = new Map<string, string>();
	const counts = { reads: 0, writes: 0, removes: 0 };
	let failWrites = false;
	const storage: StorageLike = {
		getItem(key: string): string | null {
			counts.reads += 1;
			return data.get(key) ?? null;
		},
		setItem(key: string, value: string): void {
			counts.writes += 1;
			if (failWrites) throw new Error("QuotaExceededError");
			data.set(key, value);
		},
		removeItem(key: string): void {
			counts.removes += 1;
			data.delete(key);
		},
	};
	return {
		storage,
		data,
		counts,
		setFailWrites(fail: boolean): void {
			failWrites = fail;
		},
	};
}

function passthroughSchema(): StandardSchemaV1<unknown, unknown> {
	return {
		"~standard": {
			version: 1,
			vendor: "telic-test",
			validate: (value) => ({ value }),
		},
	};
}

const KEY = "telic:tape";

function at<T>(items: readonly T[], index: number): T {
	const item = items[index];
	if (item === undefined) throw new Error(`no element at index ${index}`);
	return item;
}

describe("S18 persistence tap", () => {
	it("S18: round-trips a tape write → new runtime → restore", () => {
		const fake = makeFakeStorage();
		const writer = createTestRuntime();
		connectStorage(writer.runtime, { storage: fake.storage });
		const checkout = writer.runtime.intent("cart.checkout", {
			payload: passthroughSchema(),
		});
		checkout.begin({ items: 2 }).fulfill();
		expect(fake.data.get(KEY)).toBeDefined();

		const reader = createTestRuntime();
		connectStorage(reader.runtime, { storage: fake.storage });
		const restored = marksOf(reader.runtime, "cart.*");
		expect(restored.map((mark) => mark.kind)).toEqual(["begun", "fulfilled"]);
		expect(restored.every((mark) => mark.origin?.restored === true)).toBe(true);
		expect(reader.runtime.memory.last("cart.checkout")?.phase).toBe(
			"fulfilled",
		);
	});

	it("S18.3: malformed stored tape is dropped silently and cleared", () => {
		const fake = makeFakeStorage();
		fake.data.set(KEY, "{ not valid json");
		const rt = createTestRuntime();
		connectStorage(rt.runtime, { storage: fake.storage });

		expect(marksOf(rt.runtime)).toEqual([]); // nothing restored
		expect(fake.counts.removes).toBeGreaterThan(0); // storage cleared
		expect(fake.data.get(KEY)).toBeUndefined();
	});

	it("S18.3: resume-matching actives resurrect; others abandon(navigation)", () => {
		const fake = makeFakeStorage();
		const writer = createTestRuntime();
		connectStorage(writer.runtime, { storage: fake.storage });
		const wizardAttempt = writer.runtime
			.intent("wizard.step", { payload: passthroughSchema() })
			.begin({ step: 1 });
		const uploadAttempt = writer.runtime
			.intent("media.upload", { payload: passthroughSchema() })
			.begin({ file: "a" });

		const reader = createTestRuntime();
		connectStorage(reader.runtime, {
			storage: fake.storage,
			resume: ["wizard.*"],
		});

		expect(phaseOf(reader.runtime, wizardAttempt.id)?.phase).toBe("active");
		const uploadPhase = phaseOf(reader.runtime, uploadAttempt.id);
		expect(uploadPhase?.phase).toBe("abandoned");
		if (uploadPhase?.phase === "abandoned") {
			expect(uploadPhase.abandon.why).toBe("navigation");
		}
	});

	it("S18.1: enabled() false → no restore and no writes", () => {
		const fake = makeFakeStorage();
		const seed = createTestRuntime();
		connectStorage(seed.runtime, { storage: fake.storage });
		seed.runtime
			.intent("cart.checkout", { payload: passthroughSchema() })
			.begin({ x: 1 });
		fake.counts.reads = 0;
		fake.counts.writes = 0;

		const rt = createTestRuntime();
		connectStorage(rt.runtime, { storage: fake.storage, enabled: () => false });
		rt.runtime
			.intent("cart.checkout", { payload: passthroughSchema() })
			.begin({ x: 2 });

		expect(fake.counts.reads).toBe(0); // restore skipped (no getItem)
		expect(fake.counts.writes).toBe(0); // writes skipped (no setItem)
		// The live begin still records to memory, but nothing was RESTORED from storage.
		const cartMarks = marksOf(rt.runtime, "cart.*");
		expect(cartMarks).toHaveLength(1);
		expect(cartMarks.every((mark) => mark.origin?.restored !== true)).toBe(
			true,
		);
	});

	it("S18.2: quota write failure → tap-error diagnostic, app unbroken", () => {
		const fake = makeFakeStorage();
		const rt = createTestRuntime();
		connectStorage(rt.runtime, { storage: fake.storage });
		fake.setFailWrites(true);
		const attempt = rt.runtime
			.intent("cart.checkout", { payload: passthroughSchema() })
			.begin({ x: 1 });

		const tapError = rt.diagnostics.find(
			(diagnostic) => diagnostic.code === "tap-error",
		);
		expect(tapError).toBeDefined();
		if (tapError?.code === "tap-error") expect(tapError.tap).toBe("persist");

		// App unbroken: the attempt is recorded and still settles.
		attempt.fulfill();
		expect(rt.runtime.memory.last("cart.checkout")?.phase).toBe("fulfilled");
	});

	it("S18: maxMarks caps the persisted rolling tail", () => {
		const fake = makeFakeStorage();
		const rt = createTestRuntime();
		connectStorage(rt.runtime, { storage: fake.storage, maxMarks: 3 });
		const ping = rt.runtime.intent("beat.ping");
		for (let index = 0; index < 5; index += 1) ping.begin();

		const stored = parseWirePayload(fake.data.get(KEY) ?? "");
		expect(stored).toHaveLength(3);
		expect(stored.every((mark) => mark.kind === "begun")).toBe(true);
	});

	it("S18.5: uninstall detaches the tap (stops writes) without clearing", () => {
		const fake = makeFakeStorage();
		const rt = createTestRuntime();
		const uninstall = connectStorage(rt.runtime, { storage: fake.storage });
		const ping = rt.runtime.intent("beat.ping");
		ping.begin();
		const writesAfterFirst = fake.counts.writes;
		const persisted = fake.data.get(KEY);

		uninstall();
		ping.begin(); // must not write

		expect(fake.counts.writes).toBe(writesAfterFirst);
		expect(fake.data.get(KEY)).toBe(persisted); // storage NOT cleared by uninstall
	});

	it("S18.5: clearPersistedTape erases the stored tape", () => {
		const fake = makeFakeStorage();
		const rt = createTestRuntime();
		connectStorage(rt.runtime, { storage: fake.storage });
		rt.runtime
			.intent("cart.checkout", { payload: passthroughSchema() })
			.begin({ x: 1 });
		expect(fake.data.get(KEY)).toBeDefined();

		clearPersistedTape(fake.storage);
		expect(fake.data.get(KEY)).toBeUndefined();
	});

	it("S18: absent named storage → inert + tap-error diagnostic (SSR)", () => {
		// Bun has no globalThis.sessionStorage → resolveStorage returns undefined.
		const rt = createTestRuntime();
		const uninstall = connectStorage(rt.runtime, { storage: "session" });

		const tapError = rt.diagnostics.find(
			(diagnostic) => diagnostic.code === "tap-error",
		);
		expect(tapError).toBeDefined();
		if (tapError?.code === "tap-error") expect(tapError.tap).toBe("persist");

		// Inert: recording still works, nothing throws.
		expect(() => rt.runtime.intent("cart.checkout").begin()).not.toThrow();
		expect(() => uninstall()).not.toThrow();
	});
});
