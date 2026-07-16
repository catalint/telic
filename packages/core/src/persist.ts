/**
 * Persistence tap (SPEC S18) — a tap that persists the rolling tail of marks to
 * Web Storage, plus a restore path that rehydrates a prior session's tape.
 *
 * Exposure filtering is ABSOLUTE: `local` marks are never written; `private`
 * marks are written with the payload placeholder core already stamped. Storage
 * write failures propagate to core's S7.3 tap-error handling (persistence must
 * never break the app). Restore resurrects `resume`-matching active attempts and
 * settles the rest as `abandoned({ why: "navigation" })`.
 */
import { compilePattern, matchesPattern } from "./pattern.js";
import type {
	AttemptId,
	AttemptView,
	Exposure,
	IntentName,
	IntentPattern,
	Mark,
	MarkOrigin,
	Runtime,
	Tap,
} from "./types.js";
import { parseMark, parseWirePayload, serializeMarks } from "./wire.js";

const DEFAULT_KEY = "telic:tape";
const DEFAULT_MAX_MARKS = 200;
const TAP_ID = "persist";

/** The subset of the Web Storage API persistence needs; any `Storage` satisfies it. */
export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Named Web Storage (resolved lazily, SSR-safe) or a structural storage object. */
export type StorageChoice = "session" | "local" | StorageLike;

export type ConnectStorageOptions = {
	readonly storage: StorageChoice;
	/** Storage key. Default "telic:tape". */
	readonly key?: string;
	/** Consent / storage-classification gate, checked per write AND at restore. Default: always on. */
	readonly enabled?: () => boolean;
	/** Rolling-tail cap. Default 200. */
	readonly maxMarks?: number;
	/** Active attempts matching one of these patterns survive restore as active; others abandon. */
	readonly resume?: readonly IntentPattern[];
};

function alwaysEnabled(): boolean {
	return true;
}

function noop(): void {}

/** Resolve a storage choice; named stores read `globalThis` lazily (absent → undefined → inert). */
function resolveStorage(storage: StorageChoice): StorageLike | undefined {
	if (storage === "session" || storage === "local") {
		try {
			const resolved =
				storage === "session"
					? globalThis.sessionStorage
					: globalThis.localStorage;
			return resolved ?? undefined;
		} catch {
			// Storage access can throw in sandboxed/disabled contexts — treat as absent.
			return undefined;
		}
	}
	return storage;
}

function tryRemove(storage: StorageLike, key: string): void {
	try {
		storage.removeItem(key);
	} catch {
		// Clearing stale data must never throw.
	}
}

function trim(buffer: Mark[], maxMarks: number): void {
	if (buffer.length > maxMarks) buffer.splice(0, buffer.length - maxMarks);
}

/** Exposure of the mark's attempt: the view is authoritative; fall back to a begun mark's own field. */
function exposureOf(mark: Mark, view: AttemptView | undefined): Exposure {
	if (view !== undefined) return view.exposure;
	if (mark.kind === "begun") return mark.exposure;
	return "full";
}

/**
 * Attempt ids whose marks must never be persisted. Union of two authoritative
 * signals so a `local` mark can't leak even if its `begun` aged out of the ring
 * (retained attempts) or its record was evicted from the settled-LRU (begun scan).
 */
function localAttemptIds(
	runtime: Runtime,
	existing: readonly Mark[],
): Set<AttemptId> {
	const ids = new Set<AttemptId>();
	for (const view of runtime.memory.attempts("*")) {
		if (view.exposure === "local") ids.add(view.id);
	}
	for (const mark of existing) {
		if (mark.kind === "begun" && mark.exposure === "local")
			ids.add(mark.attempt);
	}
	return ids;
}

function stampRestored(mark: Mark): Mark {
	const origin: MarkOrigin = { ...mark.origin, restored: true };
	return { ...mark, origin };
}

/** Attempts left ACTIVE by the restored tape (begun, no terminal), keyed to their intent. */
function activeAttemptsOf(marks: readonly Mark[]): Map<AttemptId, IntentName> {
	const actives = new Map<AttemptId, IntentName>();
	for (const mark of marks) {
		switch (mark.kind) {
			case "begun":
				actives.set(mark.attempt, mark.intent);
				break;
			case "fulfilled":
			case "rejected":
			case "abandoned":
				actives.delete(mark.attempt);
				break;
			default:
				break;
		}
	}
	return actives;
}

function restore(
	runtime: Runtime,
	storage: StorageLike,
	key: string,
	resume: readonly IntentPattern[],
): void {
	let raw: string | null;
	try {
		raw = storage.getItem(key);
	} catch {
		return;
	}
	if (raw === null) return;

	const parsed = parseWirePayload(raw);
	if (parsed.length === 0) {
		// Malformed / stale / empty → dropped silently, storage cleared (S18.3).
		tryRemove(storage, key);
		return;
	}
	runtime.ingest(parsed.map(stampRestored));

	const compiled = resume.map((pattern) => compilePattern(pattern));
	const toAbandon: {
		readonly attempt: AttemptId;
		readonly intent: IntentName;
	}[] = [];
	for (const [attempt, intent] of activeAttemptsOf(parsed)) {
		// resume-matching actives are already active post-ingest (resurrected).
		if (compiled.some((pattern) => matchesPattern(pattern, intent))) continue;
		toAbandon.push({ attempt, intent });
	}
	if (toAbandon.length === 0) return;

	// snapshot().at is the only public reader of the injected clock; once per restore.
	const at = runtime.memory.snapshot().at;
	const abandonments: Mark[] = [];
	for (const { attempt, intent } of toAbandon) {
		const abandonMark = parseMark({
			kind: "abandoned",
			seq: 0,
			at,
			intent,
			attempt,
			abandon: { why: "navigation" },
		});
		if (abandonMark !== undefined) abandonments.push(abandonMark);
	}
	runtime.ingest(abandonments);
}

/**
 * SSR / storage-disabled honesty signal. No typed "storage-unavailable"
 * diagnostic exists and Runtime exposes no diagnostic emitter, so we surface
 * through core's sanctioned tap-error channel (S7.3): attach a tap that throws
 * once on attach, then detach. Do NOT "simplify" this away — silent degradation
 * of persistence is the anti-goal (cf. S8's navigation-unavailable).
 */
function signalUnavailable(runtime: Runtime): void {
	const detach = runtime.tap({
		id: TAP_ID,
		onAttach(): void {
			throw new Error("telic persist: storage unavailable");
		},
		onMark(): void {},
	});
	detach();
}

/**
 * Wire persistence onto a runtime: restore a prior tape (once, before attach),
 * then persist the rolling tail after each mark. Returns an uninstall fn that
 * detaches the tap and stops writes; it does NOT clear storage (use
 * `clearPersistedTape` for that).
 */
export function connectStorage(
	runtime: Runtime,
	opts: ConnectStorageOptions,
): () => void {
	const key = opts.key ?? DEFAULT_KEY;
	const maxMarks = opts.maxMarks ?? DEFAULT_MAX_MARKS;
	const isEnabled = opts.enabled ?? alwaysEnabled;
	const resume = opts.resume ?? [];
	const storage = resolveStorage(opts.storage);

	if (storage === undefined) {
		signalUnavailable(runtime);
		return noop;
	}

	if (isEnabled()) restore(runtime, storage, key, resume);

	const buffer: Mark[] = [];
	const tap: Tap = {
		id: TAP_ID,
		onAttach(existing: readonly Mark[]): void {
			// Seed the tail so prior history survives the first live write. Gated on
			// consent: pre-consent marks must not become persistable if it flips on.
			if (!isEnabled()) return;
			const localIds = localAttemptIds(runtime, existing);
			for (const mark of existing) {
				if (localIds.has(mark.attempt)) continue;
				buffer.push(mark);
			}
			trim(buffer, maxMarks);
		},
		onMark(mark: Mark, view: AttemptView | undefined): void {
			if (!isEnabled()) return;
			if (exposureOf(mark, view) === "local") return; // never write local (absolute)
			buffer.push(mark);
			trim(buffer, maxMarks);
			// setItem may throw (quota) — let it propagate; core's S7.3 turns it into a
			// `tap-error` (tap "persist") diagnostic and the app stays unbroken (S18.2).
			storage.setItem(key, serializeMarks(buffer));
		},
	};
	const detach = runtime.tap(tap);
	return () => {
		detach();
	};
}

/** Explicit erasure of a persisted tape (GDPR delete paths). Never throws. */
export function clearPersistedTape(storage: StorageChoice, key?: string): void {
	const resolved = resolveStorage(storage);
	if (resolved === undefined) return;
	tryRemove(resolved, key ?? DEFAULT_KEY);
}
