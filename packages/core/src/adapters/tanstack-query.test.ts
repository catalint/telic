import { describe, expect, it } from "bun:test";
import { MutationObserver, QueryClient } from "@tanstack/query-core";
import type { StandardSchemaV1 } from "../standard-schema.js";
import type { Diagnostic, Mark, ProvenanceRef, Runtime } from "../types.js";
import { createRuntime } from "../core.js";
import type { MutationCacheLike } from "./tanstack-query.js";
import { linkMutationCache, settleFromMutation } from "./tanstack-query.js";

// ---------------------------------------------------------------------------
// Test infrastructure (no external deps beyond @tanstack/query-core for
// driving REAL mutation lifecycles; duplicated per file by design).
// ---------------------------------------------------------------------------

type MakeRuntimeResult = {
	rt: Runtime;
	clock: { t: number };
	diagnostics: Diagnostic[];
};

/** Fresh, fully-injected runtime per test: mutable clock, deterministic ids, captured diagnostics. */
function makeRuntime(): MakeRuntimeResult {
	const clock = { t: 1000 };
	const diagnostics: Diagnostic[] = [];
	let counter = 0;
	const rt = createRuntime({
		now: () => clock.t,
		id: () => {
			counter += 1;
			return `att-${counter}`;
		},
		onDiagnostic: (diagnostic) => {
			diagnostics.push(diagnostic);
		},
	});
	return { rt, clock, diagnostics };
}

/** Hand-rolled synchronous pass-through Standard Schema (no zod) — gives an intent a non-void `fulfilled` type. */
function passthroughSchema(): StandardSchemaV1<unknown, unknown> {
	return {
		"~standard": {
			version: 1,
			vendor: "telic-test",
			validate: (value) => ({ value }),
		},
	};
}

function at<T>(items: readonly T[], index: number): T {
	const item = items[index];
	if (item === undefined) throw new Error(`no element at index ${index}`);
	return item;
}

function linkedMarks(rt: Runtime, attemptId?: string): Mark[] {
	const marks = rt.memory.marks({ kinds: ["linked"] });
	return attemptId === undefined ? [...marks] : marks.filter((mark) => mark.attempt === attemptId);
}

function notedMarks(rt: Runtime, attemptId?: string): Mark[] {
	const marks = rt.memory.marks({ kinds: ["noted"] });
	return attemptId === undefined ? [...marks] : marks.filter((mark) => mark.attempt === attemptId);
}

type MutationRef = Extract<ProvenanceRef, { readonly kind: "mutation" }>;

function isMutationRef(ref: ProvenanceRef): ref is MutationRef {
	return ref.kind === "mutation";
}

function refsOf(marks: readonly Mark[]): MutationRef[] {
	const refs: MutationRef[] = [];
	for (const mark of marks) {
		if (mark.kind === "linked" && isMutationRef(mark.ref)) refs.push(mark.ref);
	}
	return refs;
}

function statusesOf(marks: readonly Mark[]): string[] {
	return refsOf(marks).map((ref) => ref.status);
}

/** A structurally-conforming fake MutationCache for tests that need hand-fed, malformed, or attribution-less events. */
function fakeCache(): { cache: MutationCacheLike; emit: (event: unknown) => void } {
	let handler: ((event: unknown) => void) | undefined;
	const cache: MutationCacheLike = {
		subscribe(callback: (event: unknown) => void): () => void {
			handler = callback;
			return (): void => {
				handler = undefined;
			};
		},
	};
	return {
		cache,
		emit: (event: unknown): void => {
			handler?.(event);
		},
	};
}

// ---------------------------------------------------------------------------
// S20.2: linkMutationCache
// ---------------------------------------------------------------------------

describe("S20.2: linkMutationCache", () => {
	it("given an ambient attempt active at mutate() time, when the mutation succeeds, then linked marks record pending then success on that attempt", async () => {
		const { rt, clock } = makeRuntime();
		const client = new QueryClient();
		const unlink = linkMutationCache(rt, client.getMutationCache(), { now: () => clock.t });

		const attempt = rt.intent("billing.renew").begin();
		const observer = new MutationObserver(client, {
			mutationFn: async (vars: number) => vars * 2,
			mutationKey: ["billing", "renew"],
		});

		await rt.within(attempt, () => observer.mutate(5));

		const marks = linkedMarks(rt, attempt.id);
		expect(statusesOf(marks)).toEqual(["pending", "success"]);
		expect(at(marks, 0).at).toBe(1000);
		for (const ref of refsOf(marks)) {
			expect(ref.kind).toBe("mutation");
			expect(ref.mutationKey).toBe(JSON.stringify(["billing", "renew"]));
		}

		unlink();
	});

	it("given an ambient attempt active at mutate() time, when the mutation rejects, then linked marks record pending then error", async () => {
		const { rt, clock } = makeRuntime();
		const client = new QueryClient();
		const unlink = linkMutationCache(rt, client.getMutationCache(), { now: () => clock.t });

		const attempt = rt.intent("billing.chargeCard").begin();
		const observer = new MutationObserver(client, {
			mutationFn: async () => {
				throw new Error("card_declined");
			},
		});

		await rt.within(attempt, () => observer.mutate(undefined)).catch(() => {
			// The mutation's own promise rejection is expected and asserted via marks below.
		});

		const marks = linkedMarks(rt, attempt.id);
		expect(statusesOf(marks)).toEqual(["pending", "error"]);
		// No mutationKey configured: falls back to a stable per-instance placeholder.
		expect(at(refsOf(marks), 0).mutationKey).toMatch(/^mutation:\d+$/);

		unlink();
	});

	it("given mutation.meta.attempt, when observed, then attribution resolves without any ambient context", async () => {
		const { rt, clock } = makeRuntime();
		const client = new QueryClient();
		const unlink = linkMutationCache(rt, client.getMutationCache(), { now: () => clock.t });

		const attempt = rt.intent("cart.checkout").begin();
		const observer = new MutationObserver(client, {
			mutationFn: async () => "ok",
			meta: { attempt: attempt.id },
		});

		await observer.mutate(undefined);

		expect(statusesOf(linkedMarks(rt, attempt.id))).toEqual(["pending", "success"]);

		unlink();
	});

	it("given both meta.attempt and a different ambient attempt, when observed, then meta.attempt wins", async () => {
		const { rt, clock } = makeRuntime();
		const client = new QueryClient();
		const unlink = linkMutationCache(rt, client.getMutationCache(), { now: () => clock.t });

		const metaAttempt = rt.intent("scope.metaWins").begin();
		const ambientAttempt = rt.intent("scope.ambientLoses").begin();
		const observer = new MutationObserver(client, {
			mutationFn: async () => "ok",
			meta: { attempt: metaAttempt.id },
		});

		await rt.within(ambientAttempt, () => observer.mutate(undefined));

		expect(linkedMarks(rt, metaAttempt.id).length).toBe(2);
		expect(linkedMarks(rt, ambientAttempt.id).length).toBe(0);

		unlink();
	});

	it("given meta.attempt set to an id this runtime doesn't know, when observed even under an ambient attempt, then nothing is linked (meta wins even when unresolved)", () => {
		const { rt } = makeRuntime();
		const { cache, emit } = fakeCache();
		const unlink = linkMutationCache(rt, cache);

		const ambientAttempt = rt.intent("scope.ambientUnused").begin();
		rt.within(ambientAttempt, () => {
			emit({
				type: "added",
				mutation: {
					mutationId: 1,
					options: { meta: { attempt: "does-not-exist" } },
					state: { status: "idle", failureCount: 0 },
				},
			});
		});
		emit({
			type: "updated",
			mutation: {
				mutationId: 1,
				options: { meta: { attempt: "does-not-exist" } },
				state: { status: "pending", failureCount: 0 },
			},
		});

		expect(rt.memory.marks({ kinds: ["linked"] }).length).toBe(0);

		unlink();
	});

	it("given no meta.attempt and no ambient attempt, when a mutation is observed, then nothing is linked", () => {
		const { rt } = makeRuntime();
		const { cache, emit } = fakeCache();
		const unlink = linkMutationCache(rt, cache);

		emit({
			type: "added",
			mutation: { mutationId: 1, options: {}, state: { status: "idle", failureCount: 0 } },
		});
		emit({
			type: "updated",
			mutation: { mutationId: 1, options: {}, state: { status: "pending", failureCount: 0 } },
		});

		expect(rt.memory.marks({ kinds: ["linked"] }).length).toBe(0);

		unlink();
	});

	it("given malformed or garbage events, when observed, then the adapter is tolerant and never throws", () => {
		const { rt } = makeRuntime();
		const { cache, emit } = fakeCache();
		const unlink = linkMutationCache(rt, cache);

		expect(() => emit(null)).not.toThrow();
		expect(() => emit(undefined)).not.toThrow();
		expect(() => emit("garbage")).not.toThrow();
		expect(() => emit(42)).not.toThrow();
		expect(() => emit({})).not.toThrow();
		expect(() => emit({ type: "added" })).not.toThrow();
		expect(() => emit({ type: "added", mutation: {} })).not.toThrow();
		expect(() => emit({ type: "added", mutation: { mutationId: 1 } })).not.toThrow();
		expect(() =>
			emit({ type: "added", mutation: { mutationId: 1, options: {}, state: {} } }),
		).not.toThrow();
		expect(rt.memory.marks().length).toBe(0);

		unlink();
	});

	it("given retry: 2 and a failing-then-succeeding mutationFn, when it eventually succeeds, then noted retry marks land on the ONE attempt and no second attempt is begun", async () => {
		const { rt, clock } = makeRuntime();
		const client = new QueryClient();
		const unlink = linkMutationCache(rt, client.getMutationCache(), { now: () => clock.t });

		const attempt = rt.intent("upload.retryable").begin();
		let calls = 0;
		const observer = new MutationObserver(client, {
			mutationFn: async () => {
				calls += 1;
				if (calls === 1) throw new Error("transient");
				return "ok";
			},
			retry: 2,
			retryDelay: 0,
			meta: { attempt: attempt.id },
		});

		await observer.mutate(undefined);

		const noted = notedMarks(rt, attempt.id);
		expect(noted.length).toBeGreaterThanOrEqual(1);
		for (const mark of noted) {
			if (mark.kind !== "noted") continue;
			const data = mark.data;
			expect(typeof data).toBe("object");
			expect(data).not.toBeNull();
			if (data !== null && typeof data === "object" && "retry" in data) {
				expect(typeof data.retry).toBe("number");
			}
		}

		// The defining invariant (S20.3): retries never spawn a second attempt.
		expect(rt.memory.marks({ kinds: ["begun"] }).length).toBe(1);
		expect(statusesOf(linkedMarks(rt, attempt.id))).toEqual(["pending", "success"]);

		unlink();
	});

	it("given unlink() was already called, when the cache later notifies, then no further marks are emitted", async () => {
		const { rt, clock } = makeRuntime();
		const client = new QueryClient();
		const unlink = linkMutationCache(rt, client.getMutationCache(), { now: () => clock.t });

		const attempt = rt.intent("scope.unsubscribed").begin();
		unlink();

		const observer = new MutationObserver(client, {
			mutationFn: async () => "ok",
			meta: { attempt: attempt.id },
		});
		await observer.mutate(undefined);

		expect(linkedMarks(rt, attempt.id).length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// S20.4: settleFromMutation
// ---------------------------------------------------------------------------

describe("S20.4: settleFromMutation", () => {
	it("given hasFulfilledSchema true, when onSuccess fires, then the attempt fulfills with the mutation's data as outcome", () => {
		const { rt, clock } = makeRuntime();
		const attempt = rt.intent("cart.checkoutWithSchema", { fulfilled: passthroughSchema() }).begin();
		const settlers = settleFromMutation(attempt, { hasFulfilledSchema: true });

		settlers.onSuccess({ total: 42 }, undefined, undefined);

		expect(attempt.phase()).toEqual({ phase: "fulfilled", at: clock.t, outcome: { total: 42 } });
	});

	it("given hasFulfilledSchema is not set (default false), when onSuccess fires, then the attempt fulfills with no outcome", () => {
		const { rt, clock } = makeRuntime();
		const attempt = rt.intent("cart.checkoutNoOpt", { fulfilled: passthroughSchema() }).begin();
		const settlers = settleFromMutation(attempt);

		settlers.onSuccess({ total: 42 }, undefined, undefined);

		expect(attempt.phase()).toEqual({ phase: "fulfilled", at: clock.t, outcome: undefined });
	});

	it("given onError fires, then the attempt rejects with the mutation's error", () => {
		const { rt, clock } = makeRuntime();
		const attempt = rt.intent("payment.charge").begin();
		const settlers = settleFromMutation(attempt);
		const failure = new Error("card_declined");

		settlers.onError(failure, undefined, undefined, undefined);

		expect(attempt.phase()).toEqual({ phase: "rejected", at: clock.t, reason: failure });
	});

	it("given the attempt already settled, when a settler later fires, then it is a benign no-op (first-write-wins, S3.4)", () => {
		const { rt, clock, diagnostics } = makeRuntime();
		const attempt = rt.intent("noop.alreadySettled").begin();
		attempt.fulfill();
		const settlers = settleFromMutation(attempt);

		expect(() => settlers.onError(new Error("too late"))).not.toThrow();
		expect(attempt.phase()).toEqual({ phase: "fulfilled", at: clock.t, outcome: undefined });
		expect(diagnostics.some((diagnostic) => diagnostic.code === "double-settle")).toBe(true);
	});

	it("given onSettled, then it never settles the attempt and never throws (spread-completeness placeholder)", () => {
		const { rt } = makeRuntime();
		const attempt = rt.intent("noop.settledPlaceholder").begin();
		const settlers = settleFromMutation(attempt);

		expect(() => settlers.onSettled(undefined, null, undefined, undefined)).not.toThrow();
		expect(attempt.phase().phase).toBe("active");
	});
});

// ---------------------------------------------------------------------------
// S20: end-to-end — both halves wired together against a REAL MutationObserver
// ---------------------------------------------------------------------------

describe("S20: linkMutationCache + settleFromMutation together", () => {
	it("given both wired into one real mutation, when it succeeds, then the attempt fulfills AND a success linked mark is recorded", async () => {
		const { rt, clock } = makeRuntime();
		const client = new QueryClient();
		const unlink = linkMutationCache(rt, client.getMutationCache(), { now: () => clock.t });

		const attempt = rt.intent("order.place", { fulfilled: passthroughSchema() }).begin();
		const observer = new MutationObserver(client, {
			mutationFn: async (vars: { readonly qty: number }) => ({ orderId: "o1", qty: vars.qty }),
			meta: { attempt: attempt.id },
			...settleFromMutation(attempt, { hasFulfilledSchema: true }),
		});

		await observer.mutate({ qty: 3 });

		expect(attempt.phase()).toEqual({
			phase: "fulfilled",
			at: clock.t,
			outcome: { orderId: "o1", qty: 3 },
		});
		expect(statusesOf(linkedMarks(rt, attempt.id))).toContain("success");

		unlink();
	});
});
