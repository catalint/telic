/**
 * @telic/core runtime — implements SPEC.md S1–S11 against the type contract
 * in ./types. Zero runtime dependencies; import is side-effect-free (S11.1).
 */

import type { CompiledPattern } from "./pattern.js";
import { compilePattern, matchesPattern } from "./pattern.js";
import type { StandardSchemaV1 } from "./standard-schema.js";
import type {
	AbandonReason,
	AgentDescriptor,
	Attempt,
	AttemptId,
	AttemptPhase,
	AttemptView,
	BeginArgs,
	BeginOptions,
	Diagnostic,
	FulfillArgs,
	HasOptions,
	Intent,
	IntentConfig,
	IntentDescriptor,
	IntentEvent,
	IntentName,
	IntentPattern,
	Mark,
	MarkKind,
	MarkOrigin,
	Memory,
	MemorySnapshot,
	OnConflict,
	OnOptions,
	PayloadFor,
	Projection,
	ProjectionHandle,
	ProvenanceRef,
	Runtime,
	RuntimeMode,
	RuntimeOptions,
	Scope,
	Seq,
	SettledPhase,
	Tap,
	Unsubscribe,
	URLPatternLike,
} from "./types.js";

export type * from "./types.js";

/**
 * Local mirror of types.ts's (unexported) SchemaOut. Exported because
 * isolatedDeclarations requires every type referenced by an exported
 * signature to be nameable by consumers.
 */
export type SchemaOutput<S, D> = S extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<S> : D;

// ---------------------------------------------------------------------------
// Branded/type bridges (overload trick — no `as` casts anywhere)
// ---------------------------------------------------------------------------

function asAttemptId(value: string): AttemptId;
function asAttemptId(value: string): string {
	return value;
}

function asSeq(value: number): Seq;
function asSeq(value: number): number {
	return value;
}

function asIntentName(value: string): IntentName;
function asIntentName(value: string): string {
	return value;
}

function asIntentPattern(value: string): IntentPattern;
function asIntentPattern(value: string): string {
	return value;
}

/** Generic unchecked bridge for the few spots where the runtime's untyped core meets the typed API. */
function asTyped<T>(value: unknown): T;
function asTyped(value: unknown): unknown {
	return value;
}

function widenListener<Pat extends IntentPattern>(
	listener: (event: IntentEvent<Pat>) => void,
): (event: IntentEvent) => void;
function widenListener(listener: unknown): unknown {
	return listener;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function toUnsubscribe(fn: () => void): Unsubscribe {
	return Object.assign(fn, { [Symbol.dispose]: fn });
}

/** Default id generator, resolved at runtime-creation time (S11.2). */
function defaultIdGenerator(): () => string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return () => crypto.randomUUID();
	}
	let counter = 0;
	return () => {
		counter += 1;
		return `attempt-${counter}`;
	};
}

const SETTER_LIKE_PREFIXES = ["set", "update", "toggle", "change"] as const;

const INERT_PHASE: AttemptPhase = Object.freeze({ phase: "active", since: 0 });

// ---------------------------------------------------------------------------
// Duplicate-instance sentinel (S10.8)
// ---------------------------------------------------------------------------

/** Well-known globalThis key a loaded copy claims with its module token (S10.8). */
const INSTANCE_CLAIM_KEY = "__TELIC_CORE__";
/** This module copy's identity; a second loaded copy of @telic/core gets a distinct one. */
const moduleToken: object = {};
/** Hosts this copy has DELIVERED duplicate-instance on (S10.8: once per host per copy, counted on delivery). */
const duplicateInstanceDelivered = new WeakSet<object>();

/** Injectable probe seam for the duplicate-instance sentinel — mirrors connectBrowserLifecycle's env (S10.6/S10.8). */
export type InstanceSentinelEnv = {
	readonly browserLike: boolean;
	readonly host: Record<string, unknown>;
};

function checkDuplicateInstance(
	env: InstanceSentinelEnv,
	emit: (diagnostic: Diagnostic) => void,
	canDeliver: boolean,
): void {
	if (!env.browserLike || duplicateInstanceDelivered.has(env.host)) return;
	const claimed = env.host[INSTANCE_CLAIM_KEY];
	if (claimed === undefined) {
		env.host[INSTANCE_CLAIM_KEY] = moduleToken;
		return;
	}
	// A distinct token means a second loaded copy — never overwrite the first claimer.
	// The once-budget burns only on DELIVERY: a handler-less detection (the lazy
	// default) must not silence a later configure's onDiagnostic (S10.8).
	if (claimed !== moduleToken && canDeliver) {
		duplicateInstanceDelivered.add(env.host);
		emit({ code: "duplicate-instance" });
	}
}

// ---------------------------------------------------------------------------
// Internal records
// ---------------------------------------------------------------------------

type AttemptRecord = {
	readonly id: AttemptId;
	readonly intent: IntentName;
	readonly recordedPayload: unknown;
	readonly parent: AttemptId | undefined;
	readonly retryOf: AttemptId | undefined;
	readonly origin: MarkOrigin | undefined;
	readonly beginSeq: number;
	readonly boundTo: URLPatternLike | undefined;
	readonly keyRef: string | undefined;
	/** The raw BeginOptions key, stamped on the begun mark and AttemptView (S16.3). */
	readonly key: string | undefined;
	phase: AttemptPhase;
	lastActivity: number;
	controller: AbortController | undefined;
	settledPromise: Promise<SettledPhase> | undefined;
	settledResolve: ((phase: SettledPhase) => void) | undefined;
	abandonCleanup: (() => void) | undefined;
};

type ListenerEntry = {
	readonly pattern: IntentPattern;
	readonly compiled: CompiledPattern;
	readonly kinds: readonly MarkKind[] | undefined;
	readonly fn: (event: IntentEvent) => void;
};

type TapEntry = {
	readonly tap: Tap;
};

type ProjectionEntry = {
	readonly id: string;
	readonly reduce: (state: unknown, mark: Mark) => unknown;
	state: unknown;
	readonly subscribers: Set<(state: unknown) => void>;
};

/** Internal per-runtime controls reachable from connectBrowserLifecycle without widening the public Runtime type. */
type LifecycleControls = {
	abandonAllActive(reason: AbandonReason): void;
	abandonNavigatedAway(url: string): void;
};

const runtimeControls = new WeakMap<Runtime, LifecycleControls>();

type UntypedIntent = Intent<unknown, unknown, unknown>;

/**
 * Type-erased declaration config as stored by the module-level registry
 * (S10.4). The schema generics are erased; declareIntent only reads the
 * fields structurally, so this loses no runtime information.
 */
type StoredIntentConfig = {
	readonly payload?: StandardSchemaV1;
	readonly fulfilled?: StandardSchemaV1;
	readonly rejected?: StandardSchemaV1;
	readonly tags?: readonly string[];
	readonly agent?: AgentDescriptor;
};

/**
 * Internal per-runtime hooks for the module-level late-bound facade and the
 * mediation layer (S10.4/S10.5/S15.1/S12.5) — populated by createRuntime,
 * parallel to runtimeControls.
 */
type RuntimeInternals = {
	/**
	 * Resolves a handle without ever firing duplicate-intent: memo hit, else
	 * an already-declared name rebuilds from its FIRST declaration's config,
	 * else declares with `fallbackConfig`.
	 */
	declareOrGet(name: IntentName, fallbackConfig: StoredIntentConfig | undefined): UntypedIntent;
	emitDiagnostic(diagnostic: Diagnostic): void;
	/** Routes duplicate-intent through the runtime's once-per-name gate (S1.3-revised). */
	emitDuplicateIntent(name: IntentName): void;
	/** Whether this runtime's declaration for the name carries a fulfilled schema (S3.12 outcome mapping). */
	hasFulfilledSchema(name: IntentName): boolean;
	/** Installs the live probe behind this runtime's IntentDescriptor.handled (S12.5). */
	setHandledProbe(probe: (name: IntentName) => boolean): void;
};

const runtimeInternals = new WeakMap<Runtime, RuntimeInternals>();

/** Static half of IntentDescriptor, captured at declaration time; `handled` is live at describe() (S12.5). */
type DeclaredIntentMeta = {
	readonly name: IntentName;
	readonly tags: readonly string[];
	readonly hasPayloadSchema: boolean;
	readonly agent?: AgentDescriptor;
};

/** One first-declaration entry: the descriptor's static half + the erased config (handle rebuilds, S15.2). */
type DeclaredIntentEntry = {
	readonly meta: DeclaredIntentMeta;
	readonly config: StoredIntentConfig | undefined;
};

// ---------------------------------------------------------------------------
// createRuntime (S10.1)
// ---------------------------------------------------------------------------

export function createRuntime(opts?: RuntimeOptions, sentinelEnv?: InstanceSentinelEnv): Runtime {
	const mode: RuntimeMode = opts?.mode ?? "record";
	const now: () => number = opts?.now ?? Date.now;
	const generateId: () => string = opts?.id ?? defaultIdGenerator();
	const markLimit = opts?.limits?.marks ?? 500;
	const settledLimit = opts?.limits?.settledAttempts ?? 100;
	const onDiagnostic = opts?.onDiagnostic;

	let seqCounter = 0;
	const tape: Mark[] = [];
	const attemptsById = new Map<AttemptId, AttemptRecord>();
	const activeIds = new Set<AttemptId>();
	const settledOrder = new Set<AttemptId>();
	// Ordered registry keyed by distinct declared name; drives duplicate-intent
	// diagnostics AND describe() (first declaration's config wins — Map preserves
	// insertion order for first-declaration ordering).
	const declarations = new Map<string, DeclaredIntentEntry>();
	// Live probe behind this runtime's IntentDescriptor.handled (S12.5);
	// installed per-runtime by ./mediate — bare runtimes report false.
	let handledProbe: (name: IntentName) => boolean = (): boolean => false;
	const setterWarnedNames = new Set<string>();
	const duplicateWarnedNames = new Set<string>();
	const keyedActive = new Map<string, { readonly id: AttemptId; readonly handle: unknown }>();
	const listeners: ListenerEntry[] = [];
	const taps: TapEntry[] = [];
	const projections: ProjectionEntry[] = [];
	const ambientStack: AttemptId[] = [];

	// Shared inert plumbing for silent mode (S2.7): one never-aborting signal,
	// one forever-pending settled promise.
	let inertSignal: AbortSignal | undefined;
	let inertSettled: Promise<SettledPhase> | undefined;

	function emitDiagnostic(diagnostic: Diagnostic): void {
		if (onDiagnostic === undefined) return;
		try {
			onDiagnostic(diagnostic);
		} catch {
			// Diagnostics never throw (S10.2).
		}
	}

	// Sentinel: a second loaded copy of @telic/core booting in the browser fires
	// duplicate-instance on this runtime (S10.8). Gated by `document` like the
	// default runtime (S10.4); the probe target is injectable for tests.
	checkDuplicateInstance(
		sentinelEnv ?? {
			browserLike: typeof document !== "undefined",
			host: asTyped<Record<string, unknown>>(globalThis),
		},
		emitDiagnostic,
		onDiagnostic !== undefined,
	);

	function nextSeq(): Seq {
		seqCounter += 1;
		return asSeq(seqCounter);
	}

	function validateValue(
		schemaToUse: StandardSchemaV1,
		value: unknown,
		intentName: IntentName,
		toDiagnostic: (issues: readonly StandardSchemaV1.Issue[]) => Diagnostic,
	): void {
		let result: StandardSchemaV1.Result<unknown> | Promise<StandardSchemaV1.Result<unknown>>;
		try {
			result = schemaToUse["~standard"].validate(value);
		} catch {
			// Record-first: a throwing schema must not break the app (S2.2 spirit).
			return;
		}
		if (result instanceof Promise) {
			emitDiagnostic({ code: "async-schema", intent: intentName });
			return;
		}
		if (result.issues !== undefined) emitDiagnostic(toDiagnostic(result.issues));
	}

	function buildView(record: AttemptRecord): AttemptView {
		const view: AttemptView = {
			id: record.id,
			intent: record.intent,
			payload: record.recordedPayload,
			...(record.key !== undefined ? { key: record.key } : {}),
			...(record.parent !== undefined ? { parent: record.parent } : {}),
			...(record.retryOf !== undefined ? { retryOf: record.retryOf } : {}),
			...(record.origin !== undefined ? { origin: record.origin } : {}),
			...record.phase,
		};
		return Object.freeze(view);
	}

	function viewOf(id: AttemptId): AttemptView | undefined {
		const record = attemptsById.get(id);
		return record === undefined ? undefined : buildView(record);
	}

	/** Appends to the ring buffer and delivers: taps first (S7.2), then listeners (S5.5), then projections. */
	function deliver(mark: Mark): void {
		tape.push(mark);
		if (tape.length > markLimit) tape.splice(0, tape.length - markLimit);
		const view = viewOf(mark.attempt);
		for (const tapEntry of [...taps]) {
			try {
				tapEntry.tap.onMark(mark, view);
			} catch (error) {
				emitDiagnostic({ code: "tap-error", tap: tapEntry.tap.id, error });
			}
		}
		for (const entry of [...listeners]) {
			if (!matchesPattern(entry.compiled, mark.intent)) continue;
			if (entry.kinds !== undefined && !entry.kinds.includes(mark.kind)) continue;
			try {
				entry.fn({ mark, attempt: view });
			} catch (error) {
				emitDiagnostic({ code: "listener-error", pattern: entry.pattern, error });
			}
		}
		for (const projection of [...projections]) {
			foldProjection(projection, mark);
		}
	}

	function foldProjection(entry: ProjectionEntry, mark: Mark): void {
		let nextState: unknown;
		try {
			nextState = entry.reduce(entry.state, mark);
		} catch (error) {
			// Reducer exceptions skip the mark (S6.6).
			emitDiagnostic({ code: "listener-error", pattern: "*", error });
			return;
		}
		entry.state = nextState;
		for (const subscriber of [...entry.subscribers]) {
			try {
				subscriber(entry.state);
			} catch (error) {
				emitDiagnostic({ code: "listener-error", pattern: "*", error });
			}
		}
	}

	function evictSettledOverflow(): void {
		while (settledOrder.size > settledLimit) {
			let oldest: AttemptId | undefined;
			for (const first of settledOrder) {
				oldest = first;
				break;
			}
			if (oldest === undefined) return;
			settledOrder.delete(oldest);
			attemptsById.delete(oldest);
		}
	}

	/** State transition shared by local settles and ingested terminal marks; does NOT emit a mark. */
	function applySettledState(record: AttemptRecord, next: SettledPhase): void {
		const frozen: SettledPhase = Object.freeze(next);
		record.phase = frozen;
		record.lastActivity = frozen.at;
		activeIds.delete(record.id);
		settledOrder.add(record.id);
		if (record.keyRef !== undefined) {
			const keyEntry = keyedActive.get(record.keyRef);
			if (keyEntry !== undefined && keyEntry.id === record.id) keyedActive.delete(record.keyRef);
		}
		const cleanup = record.abandonCleanup;
		record.abandonCleanup = undefined;
		cleanup?.();
		record.controller?.abort(frozen.phase);
		const resolveSettled = record.settledResolve;
		record.settledResolve = undefined;
		resolveSettled?.(frozen);
	}

	function buildSettleMark(record: AttemptRecord, next: SettledPhase): Mark {
		const base = {
			seq: nextSeq(),
			at: next.at,
			intent: record.intent,
			attempt: record.id,
		};
		switch (next.phase) {
			case "fulfilled": {
				const mark: Mark = { kind: "fulfilled", ...base, outcome: next.outcome };
				return Object.freeze(mark);
			}
			case "rejected": {
				const mark: Mark = { kind: "rejected", ...base, reason: next.reason };
				return Object.freeze(mark);
			}
			case "abandoned": {
				const mark: Mark = { kind: "abandoned", ...base, abandon: next.abandon };
				return Object.freeze(mark);
			}
		}
	}

	/** First-write-wins settling (S3.4). Never throws. */
	function settle(record: AttemptRecord, next: SettledPhase): void {
		if (record.phase.phase !== "active") {
			emitDiagnostic({
				code: "double-settle",
				intent: record.intent,
				attempt: record.id,
				ignored: next.phase,
			});
			return;
		}
		applySettledState(record, next);
		deliver(buildSettleMark(record, next));
		evictSettledOverflow();
	}

	function fulfillAttempt(
		record: AttemptRecord,
		outcome: unknown,
		fulfilledSchema: StandardSchemaV1 | undefined,
	): void {
		if (record.phase.phase === "active" && fulfilledSchema !== undefined) {
			validateValue(fulfilledSchema, outcome, record.intent, (issues): Diagnostic => {
				return { code: "invalid-outcome", intent: record.intent, attempt: record.id, issues };
			});
		}
		settle(record, { phase: "fulfilled", at: now(), outcome });
	}

	function rejectAttempt(record: AttemptRecord, reason: unknown): void {
		settle(record, { phase: "rejected", at: now(), reason });
	}

	function abandonAttempt(record: AttemptRecord, reason: AbandonReason | undefined): void {
		settle(record, { phase: "abandoned", at: now(), abandon: reason ?? { why: "user" } });
	}

	function noteAttempt(record: AttemptRecord, data: unknown): void {
		// Notes race benignly with settlement: post-settle notes are silently ignored (S3.6).
		if (record.phase.phase !== "active") return;
		const mark: Mark = {
			kind: "noted",
			seq: nextSeq(),
			at: now(),
			intent: record.intent,
			attempt: record.id,
			data,
		};
		deliver(Object.freeze(mark));
	}

	function linkAttempt(record: AttemptRecord, ref: ProvenanceRef): void {
		// Allowed while active AND after settle (S3.7).
		const mark: Mark = {
			kind: "linked",
			seq: nextSeq(),
			at: now(),
			intent: record.intent,
			attempt: record.id,
			ref,
		};
		deliver(Object.freeze(mark));
	}

	function signalOf(record: AttemptRecord): AbortSignal {
		if (record.controller !== undefined) return record.controller.signal;
		const controller = new AbortController();
		record.controller = controller;
		if (record.phase.phase !== "active") controller.abort(record.phase.phase);
		return controller.signal;
	}

	function settledOf(record: AttemptRecord): Promise<SettledPhase> {
		if (record.settledPromise !== undefined) return record.settledPromise;
		if (record.phase.phase !== "active") {
			const resolved = Promise.resolve(record.phase);
			record.settledPromise = resolved;
			return resolved;
		}
		const { promise, resolve } = Promise.withResolvers<SettledPhase>();
		record.settledPromise = promise;
		record.settledResolve = resolve;
		return promise;
	}

	function withinById<T>(id: AttemptId, fn: () => T): T {
		ambientStack.push(id);
		try {
			return fn();
		} finally {
			ambientStack.pop();
		}
	}

	function buildAttemptHandle<P, F, R>(
		record: AttemptRecord,
		rawPayload: P,
		fulfilledSchema: StandardSchemaV1 | undefined,
	): Attempt<P, F, R> {
		const handle: Attempt<P, F, R> = {
			id: record.id,
			intent: record.intent,
			payload: rawPayload,
			get signal(): AbortSignal {
				return signalOf(record);
			},
			get settled(): Promise<SettledPhase> {
				return settledOf(record);
			},
			phase: (): AttemptPhase => record.phase,
			note: (data: unknown): void => {
				noteAttempt(record, data);
			},
			fulfill: (...fulfillArgs: FulfillArgs<F>): void => {
				const outcomeArgs: readonly unknown[] = fulfillArgs;
				fulfillAttempt(
					record,
					outcomeArgs.length > 0 ? outcomeArgs[0] : undefined,
					fulfilledSchema,
				);
			},
			reject: (reason: R): void => {
				rejectAttempt(record, reason);
			},
			abandon: (reason?: AbandonReason): void => {
				abandonAttempt(record, reason);
			},
			link: (ref: ProvenanceRef): void => {
				linkAttempt(record, ref);
			},
			wrap: <A extends readonly unknown[], T>(fn: (...fnArgs: A) => T): ((...fnArgs: A) => T) => {
				return (...fnArgs: A): T => withinById(record.id, () => fn(...fnArgs));
			},
			[Symbol.dispose]: (): void => {
				// Abandon-if-unsettled; no-op (no mark, no diagnostic) when settled (S3.11).
				if (record.phase.phase === "active") {
					settle(record, { phase: "abandoned", at: now(), abandon: { why: "dispose" } });
				}
			},
		};
		return handle;
	}

	function buildInertAttempt<P, F, R>(intentName: IntentName, rawPayload: P): Attempt<P, F, R> {
		if (inertSignal === undefined) inertSignal = new AbortController().signal;
		if (inertSettled === undefined) {
			inertSettled = new Promise<SettledPhase>(() => {
				// Never resolves: silent-mode settled is forever pending (S2.7).
			});
		}
		const handle: Attempt<P, F, R> = {
			id: asAttemptId(generateId()),
			intent: intentName,
			payload: rawPayload,
			signal: inertSignal,
			settled: inertSettled,
			phase: (): AttemptPhase => INERT_PHASE,
			note: (): void => {},
			fulfill: (): void => {},
			reject: (): void => {},
			abandon: (): void => {},
			link: (): void => {},
			wrap: <A extends readonly unknown[], T>(fn: (...fnArgs: A) => T): ((...fnArgs: A) => T) => fn,
			[Symbol.dispose]: (): void => {},
		};
		return handle;
	}

	/** duplicate-intent fires ONCE PER NAME per runtime (S1.3-revised) — HMR re-evaluation must not train diagnostic-blindness. */
	function warnDuplicateIntent(name: IntentName): void {
		if (duplicateWarnedNames.has(name)) return;
		duplicateWarnedNames.add(name);
		emitDiagnostic({ code: "duplicate-intent", intent: name });
	}

	function warnSetterLikeName(name: IntentName): void {
		const dot = name.indexOf(".");
		if (dot === -1) return;
		const rest = name.slice(dot + 1).toLowerCase();
		if (!SETTER_LIKE_PREFIXES.some((prefix) => rest.startsWith(prefix))) return;
		if (setterWarnedNames.has(name)) return;
		setterWarnedNames.add(name);
		emitDiagnostic({ code: "setter-like-name", intent: name });
	}

	function declareIntent<
		PS extends StandardSchemaV1 | undefined = undefined,
		FS extends StandardSchemaV1 | undefined = undefined,
		RS extends StandardSchemaV1 | undefined = undefined,
	>(
		name: IntentName,
		config?: IntentConfig<PS, FS, RS>,
	): Intent<SchemaOutput<PS, void>, SchemaOutput<FS, void>, SchemaOutput<RS, unknown>> {
		const alreadyDeclared = declarations.has(name);
		if (alreadyDeclared) warnDuplicateIntent(name);
		else {
			// First declaration wins for the descriptor (S12.1); `handled` is
			// computed live at describe() time, not here (S12.5). The erased
			// config is kept so declareOrGet can rebuild handles without
			// re-declaring (S15.2).
			const meta: DeclaredIntentMeta = Object.freeze({
				name,
				tags: Object.freeze([...(config?.tags ?? [])]),
				hasPayloadSchema: config?.payload !== undefined,
				// Wrapper frozen and telic-owned; `input` forwarded BY REFERENCE,
				// never deep-frozen (S12.6 / the data boundary, D30).
				...(config?.agent !== undefined ? { agent: Object.freeze({ ...config.agent }) } : {}),
			});
			declarations.set(name, { meta, config: asTyped<StoredIntentConfig | undefined>(config) });
		}
		warnSetterLikeName(name);

		// The FIRST declaration's config governs this name (S12.1/D26): on
		// re-declaration the freshly-passed config is ignored for the returned
		// handle, so describe() (which reads the frozen first meta) and the live
		// handle can never diverge — a second call with different config only shapes
		// the static type.
		const effectiveConfig: IntentConfig<PS, FS, RS> | undefined = alreadyDeclared
			? asTyped<IntentConfig<PS, FS, RS> | undefined>(declarations.get(name)?.config)
			: config;

		return buildIntentHandle<PS, FS, RS>(name, effectiveConfig);
	}

	/** Handle construction WITHOUT declaration bookkeeping — declareIntent and declareOrGet both build through here. */
	function buildIntentHandle<
		PS extends StandardSchemaV1 | undefined = undefined,
		FS extends StandardSchemaV1 | undefined = undefined,
		RS extends StandardSchemaV1 | undefined = undefined,
	>(
		name: IntentName,
		config?: IntentConfig<PS, FS, RS>,
	): Intent<SchemaOutput<PS, void>, SchemaOutput<FS, void>, SchemaOutput<RS, unknown>> {
		type P = SchemaOutput<PS, void>;
		type F = SchemaOutput<FS, void>;
		type R = SchemaOutput<RS, unknown>;

		const payloadSchema: StandardSchemaV1 | undefined = config?.payload;
		const fulfilledSchema: StandardSchemaV1 | undefined = config?.fulfilled;

		function beginWith(rawPayload: unknown, beginOpts: BeginOptions | undefined): Attempt<P, F, R> {
			if (mode === "silent") return buildInertAttempt<P, F, R>(name, asTyped<P>(rawPayload));

			if (payloadSchema !== undefined) {
				validateValue(payloadSchema, rawPayload, name, (issues): Diagnostic => {
					return { code: "invalid-payload", intent: name, issues };
				});
			}

			const key = beginOpts?.key;
			const conflict: OnConflict =
				beginOpts?.onConflict ?? (key !== undefined ? "dedupe" : "concurrent");
			const mapKey = key !== undefined ? `${name}\u0000${key}` : undefined;

			if (mapKey !== undefined && conflict === "dedupe") {
				const existing = keyedActive.get(mapKey);
				// Dedupe returns THE SAME handle, no new mark (S2.4).
				if (existing !== undefined) return asTyped<Attempt<P, F, R>>(existing.handle);
			}

			const newId = asAttemptId(generateId());

			if (mapKey !== undefined && conflict === "supersede") {
				const existing = keyedActive.get(mapKey);
				if (existing !== undefined) {
					const existingRecord = attemptsById.get(existing.id);
					// Abandon the old keyed attempt BEFORE the new begun mark (S2.4).
					if (existingRecord !== undefined) {
						settle(existingRecord, {
							phase: "abandoned",
							at: now(),
							abandon: { why: "superseded", by: newId },
						});
					}
					keyedActive.delete(mapKey);
				}
			}

			const beganAt = now();
			const parent = beginOpts?.parent ?? ambientStack[ambientStack.length - 1];
			const retryOf = beginOpts?.retryOf;
			const recordedPayload = rawPayload;
			const beginSeq = nextSeq();

			const record: AttemptRecord = {
				id: newId,
				intent: name,
				recordedPayload,
				parent,
				retryOf,
				origin: undefined,
				beginSeq,
				boundTo: beginOpts?.boundTo,
				keyRef: mapKey,
				key,
				phase: Object.freeze({ phase: "active", since: beganAt }),
				lastActivity: beganAt,
				controller: undefined,
				settledPromise: undefined,
				settledResolve: undefined,
				abandonCleanup: undefined,
			};
			attemptsById.set(newId, record);
			activeIds.add(newId);

			const begunMark: Mark = {
				kind: "begun",
				seq: beginSeq,
				at: beganAt,
				intent: name,
				attempt: newId,
				payload: recordedPayload,
				...(key !== undefined ? { key } : {}),
				...(parent !== undefined ? { parent } : {}),
				...(retryOf !== undefined ? { retryOf } : {}),
			};
			deliver(Object.freeze(begunMark));

			const handle = buildAttemptHandle<P, F, R>(record, asTyped<P>(rawPayload), fulfilledSchema);
			if (mapKey !== undefined) keyedActive.set(mapKey, { id: newId, handle });

			const abandonWhen = beginOpts?.abandonWhen;
			if (abandonWhen !== undefined) {
				if (abandonWhen.aborted) {
					settle(record, { phase: "abandoned", at: now(), abandon: { why: "signal" } });
				} else {
					const onAbort = (): void => {
						if (record.phase.phase === "active") {
							settle(record, { phase: "abandoned", at: now(), abandon: { why: "signal" } });
						}
					};
					abandonWhen.addEventListener("abort", onAbort, { once: true });
					record.abandonCleanup = (): void => {
						abandonWhen.removeEventListener("abort", onAbort);
					};
				}
			}

			return handle;
		}

		const intentHandle: Intent<P, F, R> = {
			name,
			tags: config?.tags ?? [],
			begin: (...args: BeginArgs<P>): Attempt<P, F, R> => beginWith(args[0], args[1]),
			run: async <T extends { readonly ok: boolean }>(
				payload: P,
				fn: (attempt: Attempt<P, F, R>) => Promise<T>,
				runOpts?: BeginOptions,
			): Promise<T> => {
				const handle = beginWith(payload, runOpts);
				const record = attemptsById.get(handle.id);
				let result: T;
				try {
					// try/await inside async gives Promise.try semantics: sync throws become rejections (S3.12).
					result = await fn(handle);
				} catch (thrown) {
					if (record !== undefined) rejectAttempt(record, thrown);
					throw thrown;
				}
				if (result.ok) {
					const outcome =
						fulfilledSchema !== undefined && "data" in result ? result.data : undefined;
					if (record !== undefined) fulfillAttempt(record, outcome, fulfilledSchema);
				} else if (record !== undefined) {
					rejectAttempt(record, "error" in result ? result.error : result);
				}
				return result;
			},
		};
		return intentHandle;
	}

	function subscribe<Pat extends IntentPattern>(
		pattern: Pat,
		listener: (event: IntentEvent<Pat>) => void,
		onOpts?: OnOptions,
	): Unsubscribe {
		const entry: ListenerEntry = {
			pattern,
			compiled: compilePattern(pattern),
			kinds: onOpts?.kinds,
			fn: widenListener(listener),
		};
		listeners.push(entry);
		if (onOpts?.replay === true) {
			// Synchronous replay with the CURRENT attempt view per mark (S5.4).
			for (const mark of [...tape]) {
				if (!matchesPattern(entry.compiled, mark.intent)) continue;
				if (entry.kinds !== undefined && !entry.kinds.includes(mark.kind)) continue;
				try {
					entry.fn({ mark, attempt: viewOf(mark.attempt) });
				} catch (error) {
					emitDiagnostic({ code: "listener-error", pattern: entry.pattern, error });
				}
			}
		}
		return toUnsubscribe((): void => {
			const index = listeners.indexOf(entry);
			if (index >= 0) listeners.splice(index, 1);
		});
	}

	function attachTap(tap: Tap): Unsubscribe {
		const entry: TapEntry = { tap };
		taps.push(entry);
		if (tap.onAttach !== undefined) {
			try {
				tap.onAttach([...tape]);
			} catch (error) {
				emitDiagnostic({ code: "tap-error", tap: tap.id, error });
			}
		}
		return toUnsubscribe((): void => {
			const index = taps.indexOf(entry);
			if (index >= 0) taps.splice(index, 1);
		});
	}

	function registerProjection<S>(projection: Projection<S>): ProjectionHandle<S> {
		const entry: ProjectionEntry = {
			id: projection.id,
			reduce: (state: unknown, mark: Mark): unknown => projection.reduce(asTyped<S>(state), mark),
			state: projection.init(),
			subscribers: new Set(),
		};
		for (const mark of tape) {
			try {
				entry.state = entry.reduce(entry.state, mark);
			} catch (error) {
				emitDiagnostic({ code: "listener-error", pattern: "*", error });
			}
		}
		projections.push(entry);
		const handle: ProjectionHandle<S> = {
			read: (): S => asTyped<S>(entry.state),
			subscribe(fn: (state: S) => void): Unsubscribe {
				const wrapped = (state: unknown): void => {
					fn(asTyped<S>(state));
				};
				entry.subscribers.add(wrapped);
				return toUnsubscribe((): void => {
					entry.subscribers.delete(wrapped);
				});
			},
			dispose(): void {
				const index = projections.indexOf(entry);
				if (index >= 0) projections.splice(index, 1);
			},
		};
		return handle;
	}

	function matchingRecords(compiled: CompiledPattern): AttemptRecord[] {
		const matching: AttemptRecord[] = [];
		for (const record of attemptsById.values()) {
			if (matchesPattern(compiled, record.intent)) matching.push(record);
		}
		return matching;
	}

	const memoryFacade: Memory = {
		last<Pat extends IntentPattern>(pattern: Pat): AttemptView<PayloadFor<Pat>> | undefined {
			const compiled = compilePattern(pattern);
			let best: AttemptRecord | undefined;
			for (const record of attemptsById.values()) {
				if (!matchesPattern(compiled, record.intent)) continue;
				if (best === undefined || record.beginSeq > best.beginSeq) best = record;
			}
			return best === undefined
				? undefined
				: asTyped<AttemptView<PayloadFor<Pat>>>(buildView(best));
		},
		has(pattern: IntentPattern, hasOpts?: HasOptions): boolean {
			const compiled = compilePattern(pattern);
			const reference = hasOpts?.withinMs !== undefined ? now() : 0;
			for (const record of attemptsById.values()) {
				if (!matchesPattern(compiled, record.intent)) continue;
				if (hasOpts?.phase !== undefined && record.phase.phase !== hasOpts.phase) continue;
				if (hasOpts?.withinMs !== undefined && reference - record.lastActivity > hasOpts.withinMs) {
					continue;
				}
				return true;
			}
			return false;
		},
		inProgress(scopePattern?: IntentPattern): readonly AttemptView[] {
			const compiled = scopePattern !== undefined ? compilePattern(scopePattern) : undefined;
			const views: AttemptView[] = [];
			for (const id of activeIds) {
				const record = attemptsById.get(id);
				if (record === undefined) continue;
				if (compiled !== undefined && !matchesPattern(compiled, record.intent)) continue;
				views.push(buildView(record));
			}
			return views;
		},
		attempts<Pat extends IntentPattern>(
			pattern: Pat,
			listOpts?: { readonly limit?: number },
		): readonly AttemptView<PayloadFor<Pat>>[] {
			const matching = matchingRecords(compilePattern(pattern));
			matching.sort((left, right) => right.beginSeq - left.beginSeq);
			const limited = listOpts?.limit !== undefined ? matching.slice(0, listOpts.limit) : matching;
			return limited.map((record) => asTyped<AttemptView<PayloadFor<Pat>>>(buildView(record)));
		},
		marks(marksOpts?: {
			readonly pattern?: IntentPattern;
			readonly kinds?: readonly MarkKind[];
			readonly sinceSeq?: Seq;
		}): readonly Mark[] {
			const compiled =
				marksOpts?.pattern !== undefined ? compilePattern(marksOpts.pattern) : undefined;
			return tape.filter((mark) => {
				if (compiled !== undefined && !matchesPattern(compiled, mark.intent)) return false;
				if (marksOpts?.kinds !== undefined && !marksOpts.kinds.includes(mark.kind)) return false;
				if (marksOpts?.sinceSeq !== undefined && mark.seq <= marksOpts.sinceSeq) return false;
				return true;
			});
		},
		project: registerProjection,
		snapshot(): MemorySnapshot {
			const active: AttemptView[] = [];
			for (const id of activeIds) {
				const record = attemptsById.get(id);
				if (record === undefined) continue;
				active.push(buildView(record));
			}
			const recent = tape.slice();
			const cloned = structuredClone({ active, recent });
			return Object.freeze({
				at: now(),
				seq: asSeq(seqCounter),
				active: Object.freeze(cloned.active.map((view) => Object.freeze(view))),
				recent: Object.freeze(cloned.recent.map((mark) => Object.freeze(mark))),
			});
		},
	};

	function applyForeignSettle(mark: Mark, next: SettledPhase): void {
		let record = attemptsById.get(mark.attempt);
		if (record === undefined) {
			record = {
				id: mark.attempt,
				intent: mark.intent,
				recordedPayload: undefined,
				parent: undefined,
				retryOf: undefined,
				origin: mark.origin,
				beginSeq: mark.seq,
				boundTo: undefined,
				keyRef: undefined,
				key: undefined,
				phase: Object.freeze({ phase: "active", since: mark.at }),
				lastActivity: mark.at,
				controller: undefined,
				settledPromise: undefined,
				settledResolve: undefined,
				abandonCleanup: undefined,
			};
			attemptsById.set(record.id, record);
			activeIds.add(record.id);
		}
		if (record.phase.phase === "active") applySettledState(record, next);
	}

	function applyForeignMark(mark: Mark): void {
		switch (mark.kind) {
			case "begun": {
				const existing = attemptsById.get(mark.attempt);
				// Same attempt continued from elsewhere: keep the local record.
				if (existing !== undefined && existing.intent === mark.intent) return;
				if (existing !== undefined) {
					// Id collision with an unrelated local attempt: the foreign record wins (S10.3).
					settledOrder.delete(mark.attempt);
				}
				const record: AttemptRecord = {
					id: mark.attempt,
					intent: mark.intent,
					recordedPayload: mark.payload,
					parent: mark.parent,
					retryOf: mark.retryOf,
					origin: mark.origin,
					beginSeq: mark.seq,
					boundTo: undefined,
					keyRef: undefined,
					key: mark.key,
					phase: Object.freeze({ phase: "active", since: mark.at }),
					lastActivity: mark.at,
					controller: undefined,
					settledPromise: undefined,
					settledResolve: undefined,
					abandonCleanup: undefined,
				};
				attemptsById.set(record.id, record);
				activeIds.add(record.id);
				return;
			}
			case "fulfilled":
				applyForeignSettle(mark, { phase: "fulfilled", at: mark.at, outcome: mark.outcome });
				return;
			case "rejected":
				applyForeignSettle(mark, { phase: "rejected", at: mark.at, reason: mark.reason });
				return;
			case "abandoned":
				applyForeignSettle(mark, { phase: "abandoned", at: mark.at, abandon: mark.abandon });
				return;
			default:
				return;
		}
	}

	function ingestMarks(foreignMarks: readonly Mark[]): void {
		if (mode === "silent") return;
		for (const foreign of foreignMarks) {
			// Re-seq locally: the local seq order is the tape's total order (S10.3).
			const localMark: Mark = { ...foreign, seq: nextSeq() };
			const frozen = Object.freeze(localMark);
			applyForeignMark(frozen);
			deliver(frozen);
			evictSettledOverflow();
		}
	}

	function buildScope(scopeName: string): Scope {
		const scopeFacade: Scope = {
			name: scopeName,
			intent<
				PS extends StandardSchemaV1 | undefined = undefined,
				FS extends StandardSchemaV1 | undefined = undefined,
				RS extends StandardSchemaV1 | undefined = undefined,
			>(
				verbObject: string,
				config?: IntentConfig<PS, FS, RS>,
			): Intent<SchemaOutput<PS, void>, SchemaOutput<FS, void>, SchemaOutput<RS, unknown>> {
				return declareIntent(asIntentName(`${scopeName}.${verbObject}`), config);
			},
			on(
				verbObjectPattern: string,
				listener: (event: IntentEvent) => void,
				onOpts?: OnOptions,
			): Unsubscribe {
				return subscribe(asIntentPattern(`${scopeName}.${verbObjectPattern}`), listener, onOpts);
			},
		};
		return scopeFacade;
	}

	const runtime: Runtime = {
		mode,
		memory: memoryFacade,
		// Entries built fresh per call so `handled` is live (S12.5); array and
		// entries stay frozen (S12.2).
		describe: (): readonly IntentDescriptor[] =>
			Object.freeze(
				[...declarations.values()].map(
					(entry): IntentDescriptor =>
						Object.freeze({ ...entry.meta, handled: handledProbe(entry.meta.name) }),
				),
			),
		intent: declareIntent,
		on: subscribe,
		scope: buildScope,
		tap: attachTap,
		within<T>(attempt: AttemptId | { readonly id: AttemptId }, fn: () => T): T {
			const id = typeof attempt === "string" ? attempt : attempt.id;
			return withinById(id, fn);
		},
		current(): AttemptView | undefined {
			const topId = ambientStack[ambientStack.length - 1];
			return topId === undefined ? undefined : viewOf(topId);
		},
		ingest: ingestMarks,
		seq: (): Seq => asSeq(seqCounter),
	};

	// Runtime-bound handles created through the module-level facade, memoized
	// per name so late-bound resolution never re-declares (S10.4).
	const moduleBoundHandles = new Map<IntentName, UntypedIntent>();
	runtimeInternals.set(runtime, {
		declareOrGet(name: IntentName, fallbackConfig: StoredIntentConfig | undefined): UntypedIntent {
			const memoized = moduleBoundHandles.get(name);
			if (memoized !== undefined) return memoized;
			const declared = declarations.get(name);
			// Already-declared names rebuild from their FIRST config: resolution
			// through this path never fires duplicate-intent (S15.2).
			const handle: UntypedIntent =
				declared !== undefined
					? buildIntentHandle<StandardSchemaV1, StandardSchemaV1, StandardSchemaV1>(
							name,
							declared.config,
						)
					: declareIntent<StandardSchemaV1, StandardSchemaV1, StandardSchemaV1>(
							name,
							fallbackConfig,
						);
			moduleBoundHandles.set(name, handle);
			return handle;
		},
		emitDiagnostic,
		emitDuplicateIntent: warnDuplicateIntent,
		hasFulfilledSchema: (name: IntentName): boolean =>
			declarations.get(name)?.config?.fulfilled !== undefined,
		setHandledProbe(probe: (name: IntentName) => boolean): void {
			handledProbe = probe;
		},
	});

	runtimeControls.set(runtime, {
		abandonAllActive(reason: AbandonReason): void {
			for (const id of [...activeIds]) {
				const record = attemptsById.get(id);
				if (record === undefined) continue;
				settle(record, { phase: "abandoned", at: now(), abandon: reason });
			}
		},
		abandonNavigatedAway(url: string): void {
			// Soft nav abandons ONLY boundTo-mismatched attempts; unbound attempts survive (S10.6).
			for (const id of [...activeIds]) {
				const record = attemptsById.get(id);
				if (record === undefined || record.boundTo === undefined) continue;
				let stays = true;
				try {
					stays = record.boundTo.test(url);
				} catch {
					stays = true;
				}
				if (!stays) {
					settle(record, { phase: "abandoned", at: now(), abandon: { why: "navigation" } });
				}
			}
		},
	});

	return runtime;
}

// ---------------------------------------------------------------------------
// Browser lifecycle (S10.6)
// ---------------------------------------------------------------------------

/**
 * Minimal structural environment for lifecycle wiring — injectable for tests;
 * the real `globalThis` satisfies it structurally (Navigation API optional).
 */
export type LifecycleEnv = {
	addEventListener(type: string, fn: (event: unknown) => void): void;
	removeEventListener?(type: string, fn: (event: unknown) => void): void;
	navigation?: {
		addEventListener(type: string, fn: (event: unknown) => void): void;
		removeEventListener?(type: string, fn: (event: unknown) => void): void;
		currentEntry?: { url: string };
	};
	location?: { readonly href: string };
};

function isLifecycleEnv(value: unknown): value is LifecycleEnv {
	return (
		typeof value === "object" &&
		value !== null &&
		"addEventListener" in value &&
		typeof value.addEventListener === "function"
	);
}

function detectGlobalEnv(): LifecycleEnv | undefined {
	const candidate: unknown = globalThis;
	return isLifecycleEnv(candidate) ? candidate : undefined;
}

export function connectBrowserLifecycle(runtime: Runtime, env?: LifecycleEnv): () => void {
	const resolved = env ?? detectGlobalEnv();
	const controls = runtimeControls.get(runtime);

	// Feature-detect the Navigation API; never throw when absent (S10.6). Absence
	// is NOT silent: without it, boundTo auto-abandonment degrades to a no-op, so
	// surface `navigation-unavailable` once per connect. Routed through the
	// runtime's own diagnostic channel (internalsOf); foreign runtimes no-op.
	const navigation = resolved?.navigation;
	if (navigation === undefined || typeof navigation.addEventListener !== "function") {
		internalsOf(runtime).emitDiagnostic({ code: "navigation-unavailable" });
	}

	if (resolved === undefined || controls === undefined) {
		return (): void => {
			// Nothing was connected; disconnect is a no-op.
		};
	}

	const onPagehide = (_event: unknown): void => {
		controls.abandonAllActive({ why: "navigation" });
	};
	resolved.addEventListener("pagehide", onPagehide);

	let onNavigateSuccess: ((event: unknown) => void) | undefined;
	if (navigation !== undefined && typeof navigation.addEventListener === "function") {
		onNavigateSuccess = (_event: unknown): void => {
			const entry = navigation.currentEntry;
			if (entry === undefined || entry === null) return;
			const url = entry.url;
			if (typeof url !== "string") return;
			controls.abandonNavigatedAway(url);
		};
		navigation.addEventListener("navigatesuccess", onNavigateSuccess);
	}

	let connected = true;
	return (): void => {
		if (!connected) return;
		connected = false;
		resolved.removeEventListener?.("pagehide", onPagehide);
		if (navigation !== undefined && onNavigateSuccess !== undefined) {
			navigation.removeEventListener?.("navigatesuccess", onNavigateSuccess);
		}
	};
}

// ---------------------------------------------------------------------------
// Default runtime & module-level facade (S10.4/S10.5/S10.7)
// ---------------------------------------------------------------------------

type ModuleSubscription = {
	readonly pattern: IntentPattern;
	readonly listener: (event: IntentEvent) => void;
	readonly kinds: readonly MarkKind[] | undefined;
	/** Replay is honored only on the first attach; configure re-attaches strip it (S10.4). */
	replayPending: boolean;
	detach: Unsubscribe | undefined;
};

/** Module-level declarations, in first-declaration order; the first config wins per name (S10.4). */
const moduleIntentRegistry = new Map<IntentName, StoredIntentConfig | undefined>();
/** Module-level subscriptions; each survives configureDefaultRuntime by re-attaching (S10.4). */
const moduleSubscriptions = new Set<ModuleSubscription>();

let defaultRuntimeInstance: Runtime | undefined;
let defaultRuntimeDisconnect: (() => void) | undefined;

/** Internals accessor; the fallback branch is unreachable for runtimes built by createRuntime. */
function internalsOf(runtime: Runtime): RuntimeInternals {
	const internals = runtimeInternals.get(runtime);
	if (internals !== undefined) return internals;
	return {
		declareOrGet(name: IntentName, fallbackConfig: StoredIntentConfig | undefined): UntypedIntent {
			return runtime.intent<StandardSchemaV1, StandardSchemaV1, StandardSchemaV1>(
				name,
				fallbackConfig,
			);
		},
		emitDiagnostic(): void {
			// A foreign Runtime exposes no diagnostic channel here; drop (S10.2).
		},
		emitDuplicateIntent(): void {
			// Same: no diagnostic channel to route through.
		},
		hasFulfilledSchema: (): boolean => false,
		setHandledProbe(): void {
			// A foreign Runtime keeps its default all-false handled reporting.
		},
	};
}

function attachModuleSubscription(runtime: Runtime, subscription: ModuleSubscription): void {
	const attachOpts: OnOptions = {
		...(subscription.kinds !== undefined ? { kinds: subscription.kinds } : {}),
		...(subscription.replayPending ? { replay: true } : {}),
	};
	subscription.replayPending = false;
	subscription.detach = runtime.on(subscription.pattern, subscription.listener, attachOpts);
}

/**
 * Registers every module-level declaration and subscription onto a (new)
 * default runtime — eagerly, so describe() is complete and subscriptions are
 * live BEFORE anything can record on it (S10.5).
 */
/** Callbacks run for the current default runtime and every future one (S10.5/S15.1) — fed by ./mediate. */
const defaultRuntimeAdopters: Array<(runtime: Runtime) => void> = [];

function adoptDefaultRuntime(runtime: Runtime): void {
	const internals = internalsOf(runtime);
	for (const [name, config] of moduleIntentRegistry) internals.declareOrGet(name, config);
	for (const subscription of moduleSubscriptions) {
		subscription.detach?.();
		attachModuleSubscription(runtime, subscription);
	}
	for (const adopter of defaultRuntimeAdopters) adopter(runtime);
}

/**
 * INTERNAL — registers a callback invoked with every runtime that becomes the
 * default (lazy creation and configureDefaultRuntime), and immediately with
 * the current one when it already exists. Not public API; consumed by
 * ./mediate to follow the default runtime (S15.1/S12.5).
 */
export function registerDefaultRuntimeAdopter(adopter: (runtime: Runtime) => void): void {
	defaultRuntimeAdopters.push(adopter);
	if (defaultRuntimeInstance !== undefined) adopter(defaultRuntimeInstance);
}

/** Accessor for the default runtime; creates it lazily (silent outside the browser, S10.4). */
export function currentRuntime(): Runtime {
	if (defaultRuntimeInstance === undefined) {
		const browserLike = typeof document !== "undefined";
		defaultRuntimeInstance = createRuntime(browserLike ? {} : { mode: "silent" });
		if (browserLike) defaultRuntimeDisconnect = connectBrowserLifecycle(defaultRuntimeInstance);
		adoptDefaultRuntime(defaultRuntimeInstance);
	}
	return defaultRuntimeInstance;
}

/**
 * Replaces the default runtime (S10.5). A `late-configure` diagnostic is
 * routed to the NEW runtime's onDiagnostic when the previous default had
 * already recorded.
 */
export function configureDefaultRuntime(opts: RuntimeOptions): void {
	const previous = defaultRuntimeInstance;
	const hasRecorded = previous !== undefined && previous.seq() > 0;
	defaultRuntimeDisconnect?.();
	defaultRuntimeDisconnect = undefined;
	defaultRuntimeInstance = createRuntime(opts);
	adoptDefaultRuntime(defaultRuntimeInstance);
	if (hasRecorded && opts.onDiagnostic !== undefined) {
		try {
			opts.onDiagnostic({ code: "late-configure" });
		} catch {
			// Diagnostics never throw (S10.2).
		}
	}
	if (typeof document !== "undefined") {
		defaultRuntimeDisconnect = connectBrowserLifecycle(defaultRuntimeInstance);
	}
}

/** Late-bound module-level handle: every method resolves the CURRENT default runtime at call time (S10.4/S10.7). */
function buildModuleIntentFacade<P, F, R>(name: IntentName): Intent<P, F, R> {
	// declareOrGet memoizes per (runtime, name), so resolving after a
	// configureDefaultRuntime binds to the NEW runtime without re-firing
	// duplicate-intent (the adopt step already registered the declaration).
	const resolveHandle = (): Intent<P, F, R> =>
		asTyped<Intent<P, F, R>>(
			internalsOf(currentRuntime()).declareOrGet(name, moduleIntentRegistry.get(name)),
		);
	const facade: Intent<P, F, R> = {
		name,
		tags: moduleIntentRegistry.get(name)?.tags ?? [],
		begin: (...args: BeginArgs<P>): Attempt<P, F, R> => resolveHandle().begin(...args),
		run: <T extends { readonly ok: boolean }>(
			payload: P,
			fn: (attempt: Attempt<P, F, R>) => Promise<T>,
			runOpts?: BeginOptions,
		): Promise<T> => resolveHandle().run(payload, fn, runOpts),
	};
	return facade;
}

/**
 * Module-level declaration (S10.4): stores the declaration in the module
 * registry (first config wins per name) and returns a LATE-BOUND handle, so
 * ES-module evaluation order vs configureDefaultRuntime does not matter.
 */
export function intent<
	PS extends StandardSchemaV1 | undefined = undefined,
	FS extends StandardSchemaV1 | undefined = undefined,
	RS extends StandardSchemaV1 | undefined = undefined,
>(
	name: IntentName,
	config?: IntentConfig<PS, FS, RS>,
): Intent<SchemaOutput<PS, void>, SchemaOutput<FS, void>, SchemaOutput<RS, unknown>> {
	const internals = internalsOf(currentRuntime());
	if (moduleIntentRegistry.has(name)) {
		// Repeat module-level declaration: diagnostic on the current default
		// runtime, but the registry keeps the FIRST config (S10.4). Routed
		// through the runtime's once-per-name gate (S1.3-revised).
		internals.emitDuplicateIntent(name);
	} else {
		const stored = asTyped<StoredIntentConfig | undefined>(config);
		moduleIntentRegistry.set(name, stored);
		internals.declareOrGet(name, stored);
	}
	return buildModuleIntentFacade<
		SchemaOutput<PS, void>,
		SchemaOutput<FS, void>,
		SchemaOutput<RS, unknown>
	>(name);
}

/**
 * Module-level subscription (S10.4): registered in a module-level registry so
 * it survives configureDefaultRuntime (re-attached with replay stripped).
 */
export function on<Pat extends IntentPattern>(
	pattern: Pat,
	listener: (event: IntentEvent<Pat>) => void,
	opts?: OnOptions,
): Unsubscribe {
	const subscription: ModuleSubscription = {
		pattern,
		listener: widenListener(listener),
		kinds: opts?.kinds,
		replayPending: opts?.replay === true,
		detach: undefined,
	};
	const runtime = currentRuntime();
	moduleSubscriptions.add(subscription);
	attachModuleSubscription(runtime, subscription);
	return toUnsubscribe((): void => {
		// Detaches from the CURRENT attachment and forgets the registry entry (S10.4).
		subscription.detach?.();
		subscription.detach = undefined;
		moduleSubscriptions.delete(subscription);
	});
}

/** Module-level scope facade: delegates to the late-bound module-level intent/on (S10.4). */
export function scope(name: string): Scope {
	const scopeFacade: Scope = {
		name,
		intent<
			PS extends StandardSchemaV1 | undefined = undefined,
			FS extends StandardSchemaV1 | undefined = undefined,
			RS extends StandardSchemaV1 | undefined = undefined,
		>(
			verbObject: string,
			config?: IntentConfig<PS, FS, RS>,
		): Intent<SchemaOutput<PS, void>, SchemaOutput<FS, void>, SchemaOutput<RS, unknown>> {
			return intent(asIntentName(`${name}.${verbObject}`), config);
		},
		on(
			verbObjectPattern: string,
			listener: (event: IntentEvent) => void,
			onOpts?: OnOptions,
		): Unsubscribe {
			return on(asIntentPattern(`${name}.${verbObjectPattern}`), listener, onOpts);
		},
	};
	return scopeFacade;
}

/**
 * INTERNAL — the mediation seam (S15/S16), consumed by ./mediate and ./flow.
 * Resolves the CURRENT default runtime's handle for a name, using the module
 * registry's config when one exists, without ever firing duplicate-intent
 * (declareOrGet memoizes per runtime+name). Not public API.
 */
export function resolveModuleIntent(name: IntentName): Intent<unknown, unknown, unknown> {
	return internalsOf(currentRuntime()).declareOrGet(name, moduleIntentRegistry.get(name));
}

/**
 * INTERNAL — per-runtime mediation capabilities (S15.1/S12.5), consumed by
 * ./mediate. Not public API.
 */
export type RuntimeMediationSeam = {
	/** Resolves a handle on THIS runtime without ever firing duplicate-intent (config-less when undeclared). */
	resolveIntent(name: IntentName): Intent<unknown, unknown, unknown>;
	emitDiagnostic(diagnostic: Diagnostic): void;
	/** Whether this runtime's declaration for the name carries a fulfilled schema (S3.12 outcome mapping). */
	hasFulfilledSchema(name: IntentName): boolean;
	/** Installs the live probe behind this runtime's IntentDescriptor.handled (S12.5). */
	setHandledProbe(probe: (name: IntentName) => boolean): void;
};

/** INTERNAL — the mediation seam accessor (S15.1/S12.5). Not public API. */
export function mediationSeamOf(runtime: Runtime): RuntimeMediationSeam {
	const internals = internalsOf(runtime);
	return {
		resolveIntent: (name: IntentName): Intent<unknown, unknown, unknown> =>
			internals.declareOrGet(name, undefined),
		emitDiagnostic: internals.emitDiagnostic,
		hasFulfilledSchema: internals.hasFulfilledSchema,
		setHandledProbe: internals.setHandledProbe,
	};
}

/** Delegates PER-CALL so configureDefaultRuntime replacement takes effect immediately. */
export const memory: Memory = {
	last<Pat extends IntentPattern>(pattern: Pat): AttemptView<PayloadFor<Pat>> | undefined {
		return currentRuntime().memory.last(pattern);
	},
	has(pattern: IntentPattern, opts?: HasOptions): boolean {
		return currentRuntime().memory.has(pattern, opts);
	},
	inProgress(scopePattern?: IntentPattern): readonly AttemptView[] {
		return currentRuntime().memory.inProgress(scopePattern);
	},
	attempts<Pat extends IntentPattern>(
		pattern: Pat,
		opts?: { readonly limit?: number },
	): readonly AttemptView<PayloadFor<Pat>>[] {
		return currentRuntime().memory.attempts(pattern, opts);
	},
	marks(opts?: {
		readonly pattern?: IntentPattern;
		readonly kinds?: readonly MarkKind[];
		readonly sinceSeq?: Seq;
	}): readonly Mark[] {
		return currentRuntime().memory.marks(opts);
	},
	project<S>(projection: Projection<S>): ProjectionHandle<S> {
		return currentRuntime().memory.project(projection);
	},
	snapshot(): MemorySnapshot {
		return currentRuntime().memory.snapshot();
	},
};
