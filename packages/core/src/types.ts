/**
 * @telic/core public type contract.
 *
 * Types only — the runtime lives in core.ts. Everything here is erasable,
 * isolatedDeclarations-safe, and consumable from TS 5.5 through TS 7.
 */
import type { StandardSchemaV1 } from "./standard-schema.js";

declare const AttemptIdBrand: unique symbol;
/** Opaque attempt instance id. Doubles as an Idempotency-Key for the network calls an attempt causes. */
export type AttemptId = string & { readonly [AttemptIdBrand]: true };

declare const SeqBrand: unique symbol;
/** Monotonic per-runtime sequence number, starting at 1. Total order over marks. */
export type Seq = number & { readonly [SeqBrand]: true };

/** Intent names are namespaced: `<scope>.<verbObject>`, e.g. "billing.renewDomain". */
export type IntentName = `${string}.${string}`;

/** Subscription pattern: exact name, scope wildcard ("billing.*"), or everything ("*"). */
export type IntentPattern = IntentName | `${string}.*` | "*";

/** Why an attempt was abandoned. `abandoned` is a first-class terminal state, not an error. */
export type AbandonReason =
	| { readonly why: "user"; readonly detail?: string }
	| { readonly why: "navigation" }
	| { readonly why: "unmount" }
	| { readonly why: "dispose" }
	| { readonly why: "superseded"; readonly by: AttemptId }
	| { readonly why: "signal" }
	| { readonly why: "timeout" };

/** Provenance link target: which state-layer activity an attempt caused. */
export type ProvenanceRef =
	| {
			readonly kind: "xstate";
			readonly actorId: string;
			readonly state: string;
			readonly event: string;
	  }
	| { readonly kind: "mutation"; readonly mutationKey: string; readonly status: string }
	| { readonly kind: "manual"; readonly label: string; readonly data?: unknown };

/** Where a mark came from, when not this runtime in this document. */
export type MarkOrigin = {
	readonly tab?: string;
	readonly app?: string;
	readonly restored?: boolean;
};

/** Payload reach class — how far the recorded mark is allowed to travel. A write-time `transform` applies regardless. */
export type Exposure = "full" | "local" | "private";

/**
 * One immutable, JSON-serializable entry on the tape.
 * `payload`/`outcome`/`reason`/`data` are post-transform — nothing downstream
 * of the tape ever sees the raw values.
 */
export type Mark =
	| {
			readonly kind: "begun";
			readonly seq: Seq;
			readonly at: number;
			readonly intent: IntentName;
			readonly attempt: AttemptId;
			readonly payload: unknown;
			readonly exposure: Exposure;
			readonly key?: string;
			readonly parent?: AttemptId;
			readonly retryOf?: AttemptId;
			readonly origin?: MarkOrigin;
	  }
	| {
			readonly kind: "noted";
			readonly seq: Seq;
			readonly at: number;
			readonly intent: IntentName;
			readonly attempt: AttemptId;
			readonly data: unknown;
			readonly origin?: MarkOrigin;
	  }
	| {
			readonly kind: "fulfilled";
			readonly seq: Seq;
			readonly at: number;
			readonly intent: IntentName;
			readonly attempt: AttemptId;
			readonly outcome: unknown;
			readonly origin?: MarkOrigin;
	  }
	| {
			readonly kind: "rejected";
			readonly seq: Seq;
			readonly at: number;
			readonly intent: IntentName;
			readonly attempt: AttemptId;
			readonly reason: unknown;
			readonly origin?: MarkOrigin;
	  }
	| {
			readonly kind: "abandoned";
			readonly seq: Seq;
			readonly at: number;
			readonly intent: IntentName;
			readonly attempt: AttemptId;
			readonly abandon: AbandonReason;
			readonly origin?: MarkOrigin;
	  }
	| {
			readonly kind: "linked";
			readonly seq: Seq;
			readonly at: number;
			readonly intent: IntentName;
			readonly attempt: AttemptId;
			readonly ref: ProvenanceRef;
			readonly origin?: MarkOrigin;
	  };

export type MarkKind = Mark["kind"];

/** Lifecycle phase of an attempt. Exactly one active phase; three terminal phases. */
export type AttemptPhase =
	| { readonly phase: "active"; readonly since: number }
	| { readonly phase: "fulfilled"; readonly at: number; readonly outcome: unknown }
	| { readonly phase: "rejected"; readonly at: number; readonly reason: unknown }
	| { readonly phase: "abandoned"; readonly at: number; readonly abandon: AbandonReason };

export type SettledPhase = Exclude<AttemptPhase, { phase: "active" }>;

/**
 * Read-only serializable projection of an attempt — what memory, taps and
 * foreign consumers see. `payload` is post-transform.
 */
export type AttemptView<P = unknown> = {
	readonly id: AttemptId;
	readonly intent: IntentName;
	readonly payload: P;
	readonly exposure: Exposure;
	readonly key?: string;
	readonly parent?: AttemptId;
	readonly retryOf?: AttemptId;
	readonly origin?: MarkOrigin;
} & AttemptPhase;

// ---------------------------------------------------------------------------
// Typed cross-domain registry (the one sanctioned declaration-merge point)
// ---------------------------------------------------------------------------

/** Shape of one registry entry. Use with `IntentTypes<P, F, R>`. */
export type IntentTypes<P, F = void, R = unknown> = {
	readonly payload: P;
	readonly fulfilled: F;
	readonly rejected: R;
};

/**
 * Augment from any domain to get typed `on()`/`memory` across domains:
 *
 *   declare module "@telic/core" {
 *     interface IntentRegistry {
 *       "billing.renewDomain": IntentTypes<{ domainId: string }, { expiresAt: string }>
 *     }
 *   }
 *
 * Unregistered names stay legal and type as `unknown` — progressive, not a gate.
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmentation target by design
export interface IntentRegistry {}

/** Registered names matched by a pattern; `never` when nothing is registered for it. */
export type NamesMatching<Pat extends IntentPattern> = Pat extends "*"
	? keyof IntentRegistry & IntentName
	: Pat extends `${infer S}.*`
		? Extract<keyof IntentRegistry, `${S}.${string}`> & IntentName
		: Pat & keyof IntentRegistry;

type EntryFor<N> = N extends keyof IntentRegistry ? IntentRegistry[N] : never;

/** Union of registered payload types matched by a pattern, or `unknown` if none registered. */
export type PayloadFor<Pat extends IntentPattern> = [NamesMatching<Pat>] extends [never]
	? unknown
	: EntryFor<NamesMatching<Pat>> extends { readonly payload: infer P }
		? P
		: unknown;

// ---------------------------------------------------------------------------
// Declaring intents
// ---------------------------------------------------------------------------

type SchemaOut<S, D> = S extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<S> : D;

export type IntentConfig<
	PS extends StandardSchemaV1 | undefined,
	FS extends StandardSchemaV1 | undefined,
	RS extends StandardSchemaV1 | undefined,
> = {
	/** Standard Schema (Zod 3.24+/4, Valibot, ArkType, …) for the begin payload. */
	readonly payload?: PS;
	/** Schema for the fulfil outcome. */
	readonly fulfilled?: FS;
	/** Schema for the rejection reason. */
	readonly rejected?: RS;
	/** Write-time payload mapping: runs BEFORE the payload touches the tape, producing what the mark records. Purpose-neutral (redaction, downsampling, normalization, classification); the raw payload lives only on the local Attempt handle. Payload-only — outcomes are recorded as-is. */
	readonly transform?: (payload: SchemaOut<PS, void>) => unknown;
	/** "full" (default) | "local" (excluded from persistence/transports) | "private" (payload replaced everywhere). */
	readonly exposure?: Exposure;
	/** Free metadata for taps/agents ("funnel", "wizard"). */
	readonly tags?: readonly string[];
};

export type OnConflict = "concurrent" | "dedupe" | "supersede";

/** Minimal structural URLPattern (avoids lib-dom lag; any real URLPattern satisfies it). */
export type URLPatternLike = {
	test(input: string): boolean;
};

export type BeginOptions = {
	/** Identity key for concurrent instances of the same intent (upload id, cart id, …). */
	readonly key?: string;
	/** Default: "concurrent" without a key, "dedupe" with one. */
	readonly onConflict?: OnConflict;
	/** Explicit parent attempt; the ambient `within()` attempt is used when omitted. */
	readonly parent?: AttemptId;
	/** Marks this attempt as a retry of a previous one. */
	readonly retryOf?: AttemptId;
	/** Abandons this attempt when the signal aborts (`why: "signal"`). */
	readonly abandonWhen?: AbortSignal;
	/** Auto-abandons when navigation leaves this URL pattern (`why: "navigation"`). */
	readonly boundTo?: URLPatternLike;
};

export type BeginArgs<P> = P extends void
	? [payload?: undefined, opts?: BeginOptions]
	: [payload: P, opts?: BeginOptions];

export type FulfillArgs<F> = F extends void ? [] : [outcome: F];

/** Live handle for one attempt. Settling is first-write-wins and never throws. */
export type Attempt<P = void, F = void, R = unknown> = {
	readonly id: AttemptId;
	readonly intent: IntentName;
	/** The RAW (pre-transform) payload — owner's convenience; never leaves this handle. */
	readonly payload: P;
	/** Aborts when the attempt settles or abandons. Pass to fetch(): abandoning cancels I/O. */
	readonly signal: AbortSignal;
	/** Resolves with the terminal phase. Never rejects. */
	readonly settled: Promise<SettledPhase>;
	phase(): AttemptPhase;
	note(data: unknown): void;
	fulfill(...args: FulfillArgs<F>): void;
	reject(reason: R): void;
	abandon(reason?: AbandonReason): void;
	link(ref: ProvenanceRef): void;
	/** Re-enters this attempt's ambient scope whenever the wrapped fn runs (the post-await escape hatch). */
	wrap<A extends readonly unknown[], T>(fn: (...args: A) => T): (...args: A) => T;
	/** `using attempt = …` → abandon-if-unsettled ({ why: "dispose" }) at scope exit. */
	[Symbol.dispose](): void;
};

/** A declared intent. Declaration is side-effect-free and SSR-safe. */
export type Intent<P = void, F = void, R = unknown> = {
	readonly name: IntentName;
	readonly tags: readonly string[];
	begin(...args: BeginArgs<P>): Attempt<P, F, R>;
	/**
	 * Drift-proof sugar: begins, runs `fn`, then fulfills when `fn` resolves
	 * `{ ok: true }`, rejects when `{ ok: false }`, rejects-and-rethrows on throw.
	 */
	run<T extends { readonly ok: boolean }>(
		payload: P,
		fn: (attempt: Attempt<P, F, R>) => Promise<T>,
		opts?: BeginOptions,
	): Promise<T>;
};

// ---------------------------------------------------------------------------
// Subscriptions, memory, taps
// ---------------------------------------------------------------------------

export type IntentEvent<Pat extends IntentPattern = IntentPattern> = {
	readonly mark: Mark;
	readonly attempt: AttemptView<PayloadFor<Pat>> | undefined;
};

export type OnOptions = {
	readonly kinds?: readonly MarkKind[];
	/** Deliver matching historical marks synchronously on subscribe — late mounters hear the past. */
	readonly replay?: boolean;
};

/** Unsubscribe function; also disposable (`using sub = on(…)`). */
export type Unsubscribe = (() => void) & { [Symbol.dispose](): void };

export type Projection<S> = {
	readonly id: string;
	readonly init: () => S;
	readonly reduce: (state: S, mark: Mark) => S;
};

export type ProjectionHandle<S> = {
	read(): S;
	subscribe(fn: (state: S) => void): Unsubscribe;
	dispose(): void;
};

/** JSON-serializable memory snapshot for persistence/transports/agents. */
export type MemorySnapshot = {
	readonly at: number;
	readonly seq: Seq;
	readonly active: readonly AttemptView[];
	readonly recent: readonly Mark[];
};

export type HasOptions = {
	readonly phase?: AttemptPhase["phase"];
	readonly withinMs?: number;
};

export type Memory = {
	/** Most recently begun attempt matching the pattern. */
	last<Pat extends IntentPattern>(pattern: Pat): AttemptView<PayloadFor<Pat>> | undefined;
	has(pattern: IntentPattern, opts?: HasOptions): boolean;
	/** Active attempts, oldest first. Active attempts never evict — inProgress() cannot lie. */
	inProgress(scopePattern?: IntentPattern): readonly AttemptView[];
	/** Matching attempts, most recent first. */
	attempts<Pat extends IntentPattern>(
		pattern: Pat,
		opts?: { readonly limit?: number },
	): readonly AttemptView<PayloadFor<Pat>>[];
	marks(opts?: {
		readonly pattern?: IntentPattern;
		readonly kinds?: readonly MarkKind[];
		readonly sinceSeq?: Seq;
	}): readonly Mark[];
	/** Registers a projection: replays the current tape, then folds live marks. */
	project<S>(projection: Projection<S>): ProjectionHandle<S>;
	snapshot(): MemorySnapshot;
};

/** A tape subscriber. All sinks — Sentry, analytics, devtools, transports, persistence — are taps. */
export type Tap = {
	readonly id: string;
	onMark(mark: Mark, attempt: AttemptView | undefined): void;
	/** Called once on attach with the existing tape (late-attach correctness). */
	onAttach?(existing: readonly Mark[]): void;
};

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export type Diagnostic =
	| { readonly code: "duplicate-intent"; readonly intent: IntentName }
	| { readonly code: "setter-like-name"; readonly intent: IntentName }
	| {
			readonly code: "double-settle";
			readonly intent: IntentName;
			readonly attempt: AttemptId;
			readonly ignored: SettledPhase["phase"];
	  }
	| {
			readonly code: "invalid-payload";
			readonly intent: IntentName;
			readonly issues: readonly StandardSchemaV1.Issue[];
	  }
	| {
			readonly code: "invalid-outcome";
			readonly intent: IntentName;
			readonly attempt: AttemptId;
			readonly issues: readonly StandardSchemaV1.Issue[];
	  }
	| { readonly code: "async-schema"; readonly intent: IntentName }
	| { readonly code: "listener-error"; readonly pattern: IntentPattern; readonly error: unknown }
	| { readonly code: "tap-error"; readonly tap: string; readonly error: unknown }
	| { readonly code: "late-configure" }
	| { readonly code: "handler-replaced"; readonly intent: IntentName }
	| { readonly code: "no-handler"; readonly intent: IntentName }
	| { readonly code: "missing-exposure"; readonly intent: IntentName }
	| { readonly code: "navigation-unavailable" };

export type RuntimeLimits = {
	/** Ring-buffer size for marks. Default 500. */
	readonly marks?: number;
	/** LRU size for settled attempts (active attempts never evict). Default 100. */
	readonly settledAttempts?: number;
};

export type RuntimeMode = "record" | "silent";

export type RuntimeOptions = {
	/** Injectable clock (epoch ms). Default: Date.now. */
	readonly now?: () => number;
	/** Injectable id generator. Default: crypto.randomUUID. */
	readonly id?: () => string;
	readonly limits?: RuntimeLimits;
	/** "silent": full API, inert handles, empty memory (the SSR mode). Default: "record". */
	readonly mode?: RuntimeMode;
	/** Strict privacy: declaring a payload schema without an explicit exposure → diagnostic "missing-exposure" (a `transform` does not substitute for a reach declaration). Default false. */
	readonly strictPrivacy?: boolean;
	readonly onDiagnostic?: (diagnostic: Diagnostic) => void;
};

/** Prefixed facade for one domain namespace. */
export type Scope = {
	readonly name: string;
	intent<
		PS extends StandardSchemaV1 | undefined = undefined,
		FS extends StandardSchemaV1 | undefined = undefined,
		RS extends StandardSchemaV1 | undefined = undefined,
	>(
		verbObject: string,
		config?: IntentConfig<PS, FS, RS>,
	): Intent<SchemaOut<PS, void>, SchemaOut<FS, void>, SchemaOut<RS, unknown>>;
	on(
		verbObjectPattern: string,
		listener: (event: IntentEvent) => void,
		opts?: OnOptions,
	): Unsubscribe;
};

/** One declared intent, as reported by Runtime.describe() — the agent-legible taxonomy. */
export type IntentDescriptor = {
	readonly name: IntentName;
	readonly tags: readonly string[];
	readonly exposure: Exposure;
	readonly hasPayloadSchema: boolean;
	/** True while a mediation handler is currently registered for this name (live at describe() time). */
	readonly handled: boolean;
};

export type Runtime = {
	readonly mode: RuntimeMode;
	readonly memory: Memory;
	/** Every intent declared on this runtime, in declaration order. */
	describe(): readonly IntentDescriptor[];
	intent<
		PS extends StandardSchemaV1 | undefined = undefined,
		FS extends StandardSchemaV1 | undefined = undefined,
		RS extends StandardSchemaV1 | undefined = undefined,
	>(
		name: IntentName,
		config?: IntentConfig<PS, FS, RS>,
	): Intent<SchemaOut<PS, void>, SchemaOut<FS, void>, SchemaOut<RS, unknown>>;
	on<Pat extends IntentPattern>(
		pattern: Pat,
		listener: (event: IntentEvent<Pat>) => void,
		opts?: OnOptions,
	): Unsubscribe;
	scope(name: string): Scope;
	tap(tap: Tap): Unsubscribe;
	/** Pushes `attempt` onto the ambient stack for the SYNCHRONOUS duration of `fn` (does not survive await — use attempt.wrap). */
	within<T>(attempt: AttemptId | { readonly id: AttemptId }, fn: () => T): T;
	current(): AttemptView | undefined;
	/** Feeds foreign marks (transports/persistence). Origin-stamped marks are never re-emitted to taps flagged as transports. */
	ingest(marks: readonly Mark[]): void;
	seq(): Seq;
};

// ---------------------------------------------------------------------------
// Mediation (implemented in @telic/mediate — types live here for the contract)
// ---------------------------------------------------------------------------

/** run()-style result a mediation handler resolves with; settlement follows S3.12. */
export type MediationResult = {
	readonly ok: boolean;
	readonly data?: unknown;
	readonly error?: unknown;
};

/** THE handler for an intent name — one executor per command per registry; fan-out stays on()'s job (S15.1). */
export type MediationHandler = (
	attempt: Attempt<unknown, unknown, unknown>,
	payload: unknown,
) => Promise<MediationResult>;

/** Dispatch options: BeginOptions plus the no-handler policy (S15.3/S15.7). */
export type DispatchOptions = BeginOptions & {
	/** "reject" (default): settle {code:"TELIC_NO_HANDLER"}; "park": stay active until a handler registers. */
	readonly ifUnhandled?: "reject" | "park";
};

/** Typed dispatch stub for one intent name (S15.8) — the owning domain exports it from its contract subpath. */
export type CommandStub<N extends IntentName> = (
	payload?: PayloadFor<N>,
	opts?: DispatchOptions,
) => Attempt<unknown, unknown, unknown>;

/**
 * Isolated mediation world for one runtime (S15.1): its own handler registry
 * and park queues, nothing shared with the module-level world. Created by
 * @telic/mediate's `createMediator(runtime)`.
 */
export type Mediator = {
	handle(name: IntentName, handler: MediationHandler): Unsubscribe;
	dispatch<N extends IntentName>(
		name: N,
		payload?: PayloadFor<N>,
		opts?: DispatchOptions,
	): Attempt<unknown, unknown, unknown>;
	command<N extends IntentName>(name: N): CommandStub<N>;
};

/** Helpers for consumers. */
export type InferPayload<I> = I extends Intent<infer P, unknown, unknown> ? P : never;
export type InferOutcome<I> = I extends Intent<unknown, infer F, unknown> ? F : never;
export type InferRejection<I> = I extends Intent<unknown, unknown, infer R> ? R : never;
