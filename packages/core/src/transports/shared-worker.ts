/**
 * Cross-tab hub — SharedWorker (SPEC S24).
 *
 * Two structurally-injected, independently-testable halves:
 *
 *  - `createTapeHub(runtime)` runs INSIDE the worker and owns the authoritative
 *    runtime: it ingests marks arriving on any port, re-broadcasts them to every
 *    OTHER port (as-is, so origin stamps survive — the client tap's foreign-origin
 *    skip is what keeps it loop-free), and answers `{ type: "snapshot" }` requests
 *    with `memory.snapshot()` — the authoritative cross-tab answer BroadcastChannel
 *    gossip cannot give.
 *  - `connectSharedWorker(runtime, opts)` is the client half: same wire /
 *    loop-safety / exposure semantics as S22, plus `requestSnapshot()` which
 *    correlates request/response by id. There is NO timeout (initiative boundary);
 *    a caller wanting one wraps the promise with AbortSignal / Promise.race.
 *
 * Marks travel as raw wire strings; snapshot request/response are objects tagged
 * `type: "snapshot"` — the two are disambiguated by `typeof data`, so a client
 * distinguishes a broadcast (string) from a snapshot answer (object). No timers,
 * no reconnection (S24.3): a dead port is the app's problem to reconnect.
 */
import { type CompiledPattern, compilePattern, matchesPattern } from "../pattern.js";
import type {
	AttemptView,
	Exposure,
	IntentPattern,
	Mark,
	MarkOrigin,
	MemorySnapshot,
	Runtime,
	Tap,
} from "../types.js";
import { parseWirePayload, serializeMarks } from "../wire.js";

const TAP_ID = "transport:shared-worker";

/** The subset of MessagePort both halves need; the real port satisfies it, tests inject fakes. */
export type MessagePortLike = {
	postMessage(data: unknown): void;
	addEventListener?(type: "message", handler: (event: { readonly data: unknown }) => void): void;
	removeEventListener?(
		type: "message",
		handler: (event: { readonly data: unknown }) => void,
	): void;
	onmessage?: ((event: { readonly data: unknown }) => void) | null;
	start?(): void;
	close?(): void;
};

/** The worker-side hub: register ports; each `connect` returns a detach fn. */
export type TapeHub = {
	connect(port: MessagePortLike): () => void;
};

export type ConnectSharedWorkerOptions = {
	/** A ready MessagePort (the SharedWorker's `.port`), or supply `workerFactory`. */
	readonly port?: MessagePortLike;
	/** Structural port builder; default `() => new SharedWorker(url).port`, feature-detected. */
	readonly workerFactory?: () => MessagePortLike;
	/** URL for the default SharedWorker — used only when neither `port` nor `workerFactory` is given. */
	readonly url?: string | URL;
	/** Outgoing intent-pattern filter. Default: all. */
	readonly send?: readonly IntentPattern[];
	/** Incoming intent-pattern filter. Default: all. */
	readonly accept?: readonly IntentPattern[];
	/** This tab's id for origin stamping. Default: a fresh generated id. */
	readonly tab?: string;
};

/** The client half's handle. */
export type SharedWorkerConnection = {
	disconnect(): void;
	requestSnapshot(): Promise<MemorySnapshot>;
};

type SnapshotRequest = { readonly type: "snapshot"; readonly id: string };
type SnapshotResponse = {
	readonly type: "snapshot";
	readonly id: string;
	readonly snapshot: MemorySnapshot;
};

// ---------------------------------------------------------------------------
// Structural bridges (sanctioned overload helper — no `as`, mirrors core/wire)
// ---------------------------------------------------------------------------

function asPortLike(port: MessagePort): MessagePortLike;
function asPortLike(port: unknown): unknown {
	return port;
}

function asSnapshot(value: unknown): MemorySnapshot;
function asSnapshot(value: unknown): unknown {
	return value;
}

// ---------------------------------------------------------------------------
// Shared helpers (kept local so this subpath stays independently tree-shakeable)
// ---------------------------------------------------------------------------

function noop(): void {}

function generateId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `sw-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSnapshotRequest(data: unknown): data is SnapshotRequest {
	return (
		isRecord(data) && data.type === "snapshot" && typeof data.id === "string" && !("snapshot" in data)
	);
}

function isSnapshotResponse(data: unknown): data is { readonly id: string; readonly snapshot: unknown } {
	return (
		isRecord(data) && data.type === "snapshot" && typeof data.id === "string" && "snapshot" in data
	);
}

/** Exposure of the mark's attempt: the view is authoritative; fall back to a begun mark's own field. */
function exposureOf(mark: Mark, view: AttemptView | undefined): Exposure {
	if (view !== undefined) return view.exposure;
	if (mark.kind === "begun") return mark.exposure;
	return "full";
}

function compileFilter(
	patterns: readonly IntentPattern[] | undefined,
): readonly CompiledPattern[] | undefined {
	return patterns === undefined ? undefined : patterns.map((pattern) => compilePattern(pattern));
}

function matchesFilter(compiled: readonly CompiledPattern[] | undefined, mark: Mark): boolean {
	return compiled === undefined || compiled.some((pattern) => matchesPattern(pattern, mark.intent));
}

/** Loop safety + exposure + send filter — the outgoing gate. */
function shouldSend(
	mark: Mark,
	view: AttemptView | undefined,
	sendFilter: readonly CompiledPattern[] | undefined,
): boolean {
	if (mark.origin !== undefined) return false; // foreign — never re-send (loop safety)
	if (exposureOf(mark, view) === "local") return false; // never leaves the runtime
	return matchesFilter(sendFilter, mark);
}

function stamp(mark: Mark, tab: string): Mark {
	const origin: MarkOrigin = { ...mark.origin, tab };
	return { ...mark, origin };
}

function listenOn(port: MessagePortLike, handler: (data: unknown) => void): () => void {
	const onMessage = (event: { readonly data: unknown }): void => {
		handler(event.data);
	};
	if (typeof port.addEventListener === "function") {
		port.addEventListener("message", onMessage);
		return (): void => {
			port.removeEventListener?.("message", onMessage);
		};
	}
	port.onmessage = onMessage;
	return (): void => {
		if (port.onmessage === onMessage) port.onmessage = null;
	};
}

/**
 * SSR / API-absent honesty signal (S24.2). Mirrors the other transports:
 * surface through core's sanctioned tap-error channel (S7.3) — a tap that
 * throws once on attach, then detaches. Silent degradation is the anti-goal.
 */
function signalUnavailable(runtime: Runtime, message: string): void {
	const detach = runtime.tap({
		id: TAP_ID,
		onAttach(): void {
			throw new Error(message);
		},
		onMark(): void {},
	});
	detach();
}

function resolvePort(opts: ConnectSharedWorkerOptions): MessagePortLike | undefined {
	if (opts.port !== undefined) return opts.port;
	if (opts.workerFactory !== undefined) return opts.workerFactory();
	if (typeof SharedWorker !== "undefined" && opts.url !== undefined) {
		return asPortLike(new SharedWorker(opts.url).port);
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// createTapeHub — the authoritative worker-side runtime (S24.1)
// ---------------------------------------------------------------------------

export function createTapeHub(runtime: Runtime): TapeHub {
	const ports = new Set<MessagePortLike>();
	return {
		connect(port: MessagePortLike): () => void {
			ports.add(port);
			const stopListening = listenOn(port, (data: unknown): void => {
				if (typeof data === "string") {
					const marks = parseWirePayload(data);
					if (marks.length === 0) return; // malformed dropped silently
					runtime.ingest(marks); // authoritative tape
					// Fan out the raw wire to every OTHER port, unchanged — the origin
					// stamps ride along, so each peer's tap skips them (loop safety).
					for (const other of ports) {
						if (other !== port) other.postMessage(data);
					}
					return;
				}
				if (isSnapshotRequest(data)) {
					const response: SnapshotResponse = {
						type: "snapshot",
						id: data.id,
						snapshot: runtime.memory.snapshot(),
					};
					port.postMessage(response); // answer only the requesting port
				}
			});
			port.start?.();
			return (): void => {
				ports.delete(port);
				stopListening();
			};
		},
	};
}

// ---------------------------------------------------------------------------
// connectSharedWorker — the client half (S24.2)
// ---------------------------------------------------------------------------

export function connectSharedWorker(
	runtime: Runtime,
	opts: ConnectSharedWorkerOptions,
): SharedWorkerConnection {
	const tab = opts.tab ?? generateId();
	const sendFilter = compileFilter(opts.send);
	const acceptFilter = compileFilter(opts.accept);

	const port = resolvePort(opts);
	if (port === undefined) {
		signalUnavailable(runtime, "telic shared-worker: SharedWorker unavailable");
		return {
			disconnect: noop,
			requestSnapshot(): Promise<MemorySnapshot> {
				// Reject rather than hang: an unanswerable request must not silently
				// stall a caller (the codebase's anti-silent-degradation stance).
				return Promise.reject(new Error("telic shared-worker: unavailable"));
			},
		};
	}

	const pending = new Map<string, (snapshot: MemorySnapshot) => void>();
	const rejecters = new Map<string, (error: Error) => void>();

	const stopListening = listenOn(port, (data: unknown): void => {
		if (typeof data === "string") {
			const marks = parseWirePayload(data);
			if (marks.length === 0) return; // malformed dropped silently
			const accepted = marks.filter((mark) => matchesFilter(acceptFilter, mark));
			if (accepted.length === 0) return;
			runtime.ingest(accepted);
			return;
		}
		if (isSnapshotResponse(data)) {
			const resolve = pending.get(data.id);
			if (resolve === undefined) return;
			pending.delete(data.id);
			rejecters.delete(data.id);
			resolve(asSnapshot(data.snapshot));
		}
	});
	port.start?.();

	// Forward-only live gossip: NO onAttach (see the BroadcastChannel transport).
	const tap: Tap = {
		id: TAP_ID,
		onMark(mark: Mark, view: AttemptView | undefined): void {
			if (!shouldSend(mark, view, sendFilter)) return;
			port.postMessage(serializeMarks([stamp(mark, tab)]));
		},
	};
	const detach = runtime.tap(tap);

	let connected = true;
	return {
		disconnect(): void {
			if (!connected) return;
			connected = false;
			detach();
			stopListening();
			for (const reject of rejecters.values()) {
				reject(new Error("telic shared-worker: disconnected"));
			}
			pending.clear();
			rejecters.clear();
			port.close?.();
		},
		requestSnapshot(): Promise<MemorySnapshot> {
			if (!connected) {
				return Promise.reject(new Error("telic shared-worker: disconnected"));
			}
			const id = generateId();
			const { promise, resolve, reject } = Promise.withResolvers<MemorySnapshot>();
			pending.set(id, resolve);
			rejecters.set(id, reject);
			const request: SnapshotRequest = { type: "snapshot", id };
			port.postMessage(request);
			return promise;
		},
	};
}
