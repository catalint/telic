/**
 * TanStack Query adapter (SPEC S20). Structural peer only — no @tanstack
 * import here (S20.1); `@tanstack/query-core` is a devDependency for this
 * file's tests only. Every shape read off a mutation/event is validated
 * defensively at runtime (the real event objects are never imported as
 * types), so a future query-core internal-shape change degrades to
 * "adapter observes nothing" rather than a crash.
 *
 * ADAPTERS LINK, THEY NEVER DECLARE (APPROACHES.md): nothing here calls
 * intent()/begin() — it only annotates an attempt the app already began,
 * found via `meta.attempt` or the ambient `within()` stack.
 */
import type { Attempt, AttemptView, FulfillArgs, Mark, ProvenanceRef, Runtime } from "../types.js";

// ---------------------------------------------------------------------------
// S20.2: linkMutationCache
// ---------------------------------------------------------------------------

/** Structural MutationCache contract — matches @tanstack/query-core's `MutationCache` without importing it. */
export type MutationCacheLike = {
	subscribe(callback: (event: unknown) => void): () => void;
};

export type LinkMutationCacheOptions = {
	/**
	 * Injectable clock for `linked`/`noted` mark timestamps — `runtime.ingest()`
	 * re-seqs marks but does NOT overwrite `at`, so this must agree with the
	 * runtime's own clock. Pass the SAME `now` given to `createRuntime` for
	 * deterministic tests. Default: `Date.now`.
	 */
	readonly now?: () => number;
};

type ParsedMutation = {
	readonly mutationId: number;
	readonly meta: Record<string, unknown> | undefined;
	readonly mutationKeyRaw: unknown;
	readonly status: string;
	readonly failureCount: number;
};

type ParsedEvent = {
	readonly type: string;
	readonly mutation: ParsedMutation;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Reads only the fields this adapter needs off an unknown `mutation`; anything else is ignored. */
function parseMutation(value: unknown): ParsedMutation | undefined {
	if (!isRecord(value)) return undefined;
	const mutationId = value.mutationId;
	if (typeof mutationId !== "number") return undefined;
	const options = value.options;
	if (!isRecord(options)) return undefined;
	const state = value.state;
	if (!isRecord(state)) return undefined;
	const status = state.status;
	if (typeof status !== "string") return undefined;
	const failureCount = state.failureCount;
	if (typeof failureCount !== "number") return undefined;
	const meta = options.meta;
	return {
		mutationId,
		meta: isRecord(meta) ? meta : undefined,
		mutationKeyRaw: options.mutationKey,
		status,
		failureCount,
	};
}

function parseEvent(value: unknown): ParsedEvent | undefined {
	if (!isRecord(value)) return undefined;
	const type = value.type;
	if (typeof type !== "string") return undefined;
	const mutation = parseMutation(value.mutation);
	if (mutation === undefined) return undefined;
	return { type, mutation };
}

function extractMetaAttemptId(meta: Record<string, unknown> | undefined): string | undefined {
	if (meta === undefined) return undefined;
	const attempt = meta.attempt;
	return typeof attempt === "string" && attempt.length > 0 ? attempt : undefined;
}

/** Linear scan is fine here: bounded by the runtime's own retention limits (S4.3/S4.4), called once per mutation instance. */
function findAttemptView(runtime: Runtime, id: string): AttemptView | undefined {
	for (const view of runtime.memory.attempts("*")) {
		if (view.id === id) return view;
	}
	return undefined;
}

/** S20.2 attribution: `meta.attempt` wins when resolvable; else the ambient `current()` attempt — meaningful only synchronously (S9.3), so this must run at first-sighting time. */
function resolveAttribution(
	runtime: Runtime,
	meta: Record<string, unknown> | undefined,
): AttemptView | undefined {
	const metaAttemptId = extractMetaAttemptId(meta);
	if (metaAttemptId !== undefined) return findAttemptView(runtime, metaAttemptId);
	return runtime.current();
}

function stringifyMutationKey(raw: unknown, mutationId: number): string {
	if (raw === undefined) return `mutation:${mutationId}`;
	try {
		return JSON.stringify(raw) ?? `mutation:${mutationId}`;
	} catch {
		return `mutation:${mutationId}`;
	}
}

function emitLinked(runtime: Runtime, attempt: AttemptView, ref: ProvenanceRef, at: number): void {
	const mark: Mark = {
		kind: "linked",
		seq: runtime.seq(),
		at,
		intent: attempt.intent,
		attempt: attempt.id,
		ref,
	};
	runtime.ingest([mark]);
}

function emitNoted(runtime: Runtime, attempt: AttemptView, data: unknown, at: number): void {
	const mark: Mark = {
		kind: "noted",
		seq: runtime.seq(),
		at,
		intent: attempt.intent,
		attempt: attempt.id,
		data,
	};
	runtime.ingest([mark]);
}

type TrackedMutation = {
	readonly attempt: AttemptView;
	lastStatus: string;
	lastFailureCount: number;
};

/**
 * S20.2: subscribes to a MutationCache-shaped `cache` and mirrors its status
 * transitions onto the attempt the app already began — via `meta.attempt` or
 * the ambient attempt active when the mutation was first observed (normally
 * synchronously inside `mutation.mutate()`: `MutationCache.build()` fires its
 * `"added"` notification before any `await`, S9.3). A mutation instance whose
 * attribution can't be resolved (no meta.attempt, no ambient attempt, or a
 * meta.attempt that doesn't resolve to a known attempt) is silently skipped —
 * this adapter never begins an attempt of its own.
 *
 * The FIRST observed event for a mutation instance only seeds the baseline
 * (typically status "idle"); no mark is emitted for it. Every subsequent
 * status change emits a `linked` mark (S20.4 ProvenanceRef, kind "mutation").
 *
 * S20.3 (retry semantics, D17 — decided): React Query's INTERNAL retries
 * (`state.failureCount` increasing while `state.status` stays "pending") are
 * execution detail, not user intent — they surface as `noted` marks
 * (`{ retry: n }`) on the ONE linked attempt. `retryOf` chains stay reserved
 * for USER-initiated retries: a new `begin()` the app records itself.
 *
 * Returns an unsubscribe function.
 */
export function linkMutationCache(
	runtime: Runtime,
	cache: MutationCacheLike,
	opts?: LinkMutationCacheOptions,
): () => void {
	const now = opts?.now ?? Date.now;
	const tracked = new Map<number, TrackedMutation>();

	const unsubscribe = cache.subscribe((event: unknown): void => {
		const parsed = parseEvent(event);
		if (parsed === undefined) return;

		if (parsed.type === "removed") {
			tracked.delete(parsed.mutation.mutationId);
			return;
		}
		if (parsed.type !== "added" && parsed.type !== "updated") return;

		const { mutationId, status, failureCount, mutationKeyRaw, meta } = parsed.mutation;

		let entry = tracked.get(mutationId);
		if (entry === undefined) {
			const attempt = resolveAttribution(runtime, meta);
			if (attempt === undefined) return;
			tracked.set(mutationId, { attempt, lastStatus: status, lastFailureCount: failureCount });
			return;
		}

		const at = now();

		if (status === "pending" && failureCount > entry.lastFailureCount) {
			entry.lastFailureCount = failureCount;
			emitNoted(runtime, entry.attempt, { retry: failureCount }, at);
		}

		if (status !== entry.lastStatus) {
			entry.lastStatus = status;
			const ref: ProvenanceRef = {
				kind: "mutation",
				mutationKey: stringifyMutationKey(mutationKeyRaw, mutationId),
				status,
			};
			emitLinked(runtime, entry.attempt, ref, at);
		}
	});

	return (): void => {
		unsubscribe();
		tracked.clear();
	};
}

// ---------------------------------------------------------------------------
// S20.4: settleFromMutation
// ---------------------------------------------------------------------------

export type SettleFromMutationOptions = {
	/**
	 * The adapter cannot introspect Standard Schema declarations (S20.4) — set
	 * true when the intent declared a `fulfilled` schema so the mutation's
	 * `data` becomes the fulfil outcome; false (default) fulfils with no
	 * outcome.
	 */
	readonly hasFulfilledSchema?: boolean;
};

/** Callback bag meant to be spread into a real `useMutation`/mutation-options object; extra TanStack args (variables, context, …) are accepted and ignored. */
export type MutationSettlers<F, R> = {
	readonly onSuccess: (data: F, ...rest: readonly unknown[]) => void;
	readonly onError: (error: R, ...rest: readonly unknown[]) => void;
	readonly onSettled: (...args: readonly unknown[]) => void;
};

/**
 * Bridges a runtime-decided argument list to `Attempt.fulfill`'s compile-time
 * -only `FulfillArgs<F>` tuple. `hasFulfilledSchema` is a runtime opt; F's
 * void-ness is a compile-time fact the caller can't correlate with it from
 * here — this mirrors core.ts's own `asTyped` escape hatch (same rationale:
 * a sanctioned overload, not a real cast).
 */
function asFulfillArgs<F>(args: readonly unknown[]): FulfillArgs<F>;
function asFulfillArgs(args: readonly unknown[]): readonly unknown[] {
	return args;
}

/**
 * S20.4: maps a TanStack mutation's settlement onto `attempt` — spread the
 * result into the mutation's options. success → fulfill (outcome included
 * only when `opts.hasFulfilledSchema`), error → reject with the error.
 * Settling is first-write-wins (S3.4): a mutation callback firing after the
 * attempt already settled some other way is a benign no-op, never a throw.
 *
 * NEVER wires cancellation automatically (S20.5) — `attempt.signal` aborting
 * a query is the app's own explicit choice: pass `signal: attempt.signal` to
 * `fetch()` (or the query lib's own cancellation hook) inside the
 * `mutationFn` yourself.
 */
export function settleFromMutation<P, F, R>(
	attempt: Attempt<P, F, R>,
	opts?: SettleFromMutationOptions,
): MutationSettlers<F, R> {
	const hasFulfilledSchema = opts?.hasFulfilledSchema ?? false;
	return {
		onSuccess: (data: F): void => {
			attempt.fulfill(...asFulfillArgs<F>(hasFulfilledSchema ? [data] : []));
		},
		onError: (error: R): void => {
			attempt.reject(error);
		},
		onSettled: (): void => {
			// No-op: settlement already happened in onSuccess/onError above.
			// Returned only so apps can spread all three into mutation options.
		},
	};
}
