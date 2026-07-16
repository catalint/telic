/**
 * Cross-tab transport — BroadcastChannel (SPEC S22).
 *
 * A forward-only gossip bridge between same-origin tabs. An outgoing tap
 * serializes LOCAL marks — never marks that already carry a foreign `origin`,
 * which is the whole of loop safety — and posts them via the wire format,
 * stamped with this tab's id. Incoming messages are tolerantly wire-parsed,
 * accept-filtered, and fed to `runtime.ingest`. Exposure is absolute: `local`
 * never leaves the runtime; `private` travels with the placeholder core already
 * stamped on the payload. Every environment touch is feature-detected and
 * structurally injectable (`channelFactory`), so every path runs under fakes.
 */
import { type CompiledPattern, compilePattern, matchesPattern } from "../pattern.js";
import type {
	AttemptView,
	Exposure,
	IntentPattern,
	Mark,
	MarkOrigin,
	Runtime,
	Tap,
} from "../types.js";
import { parseWirePayload, serializeMarks } from "../wire.js";

const DEFAULT_CHANNEL = "telic";
const TAP_ID = "transport:broadcast";

/** The subset of BroadcastChannel this transport needs; the real one satisfies it, tests inject a fake. */
export type BroadcastChannelLike = {
	postMessage(data: unknown): void;
	addEventListener?(type: "message", handler: (event: { readonly data: unknown }) => void): void;
	removeEventListener?(
		type: "message",
		handler: (event: { readonly data: unknown }) => void,
	): void;
	onmessage?: ((event: { readonly data: unknown }) => void) | null;
	close(): void;
};

export type ConnectBroadcastChannelOptions = {
	/** Channel name. Default "telic". */
	readonly channel?: string;
	/** Outgoing intent-pattern filter. Default: all. */
	readonly send?: readonly IntentPattern[];
	/** Incoming intent-pattern filter. Default: all. */
	readonly accept?: readonly IntentPattern[];
	/** This tab's id for origin stamping. Default: a fresh generated id. */
	readonly tab?: string;
	/** Structural channel builder for tests; default `new BroadcastChannel(name)`, feature-detected. */
	readonly channelFactory?: (name: string) => BroadcastChannelLike;
};

// ---------------------------------------------------------------------------
// Structural bridges (sanctioned overload helper — no `as`, mirrors core/wire)
// ---------------------------------------------------------------------------

function asChannelLike(channel: BroadcastChannel): BroadcastChannelLike;
function asChannelLike(channel: unknown): unknown {
	return channel;
}

// ---------------------------------------------------------------------------
// Shared helpers (kept local so this subpath stays independently tree-shakeable)
// ---------------------------------------------------------------------------

function noop(): void {}

function generateTabId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `tab-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
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

/**
 * SSR / API-absent honesty signal (S22.1). No typed "transport-unavailable"
 * diagnostic exists and Runtime exposes no diagnostic emitter, so surface
 * through core's sanctioned tap-error channel (S7.3): attach a tap that throws
 * once on attach, then detach. Silent degradation is the anti-goal.
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

function listenOn(channel: BroadcastChannelLike, handler: (data: unknown) => void): () => void {
	const onMessage = (event: { readonly data: unknown }): void => {
		handler(event.data);
	};
	if (typeof channel.addEventListener === "function") {
		channel.addEventListener("message", onMessage);
		return (): void => {
			channel.removeEventListener?.("message", onMessage);
		};
	}
	channel.onmessage = onMessage;
	return (): void => {
		if (channel.onmessage === onMessage) channel.onmessage = null;
	};
}

function resolveChannel(
	name: string,
	factory: ((name: string) => BroadcastChannelLike) | undefined,
): BroadcastChannelLike | undefined {
	if (factory !== undefined) return factory(name);
	if (typeof BroadcastChannel !== "undefined") return asChannelLike(new BroadcastChannel(name));
	return undefined;
}

// ---------------------------------------------------------------------------
// connectBroadcastChannel (S22)
// ---------------------------------------------------------------------------

export function connectBroadcastChannel(
	runtime: Runtime,
	opts?: ConnectBroadcastChannelOptions,
): () => void {
	const name = opts?.channel ?? DEFAULT_CHANNEL;
	const tab = opts?.tab ?? generateTabId();
	const sendFilter = compileFilter(opts?.send);
	const acceptFilter = compileFilter(opts?.accept);

	const channel = resolveChannel(name, opts?.channelFactory);
	if (channel === undefined) {
		signalUnavailable(runtime, "telic broadcast: BroadcastChannel unavailable");
		return noop;
	}

	const stopListening = listenOn(channel, (data: unknown): void => {
		if (typeof data !== "string") return; // non-wire dropped silently (S22.3)
		const marks = parseWirePayload(data);
		if (marks.length === 0) return; // malformed dropped silently
		const accepted = marks.filter((mark) => matchesFilter(acceptFilter, mark));
		if (accepted.length === 0) return;
		runtime.ingest(accepted);
	});

	// Forward-only live gossip: NO onAttach. Re-broadcasting the backlog would
	// burst every tab's history at every peer; catch-up is SharedWorker's
	// requestSnapshot job (S24), not this transport's.
	const tap: Tap = {
		id: TAP_ID,
		onMark(mark: Mark, view: AttemptView | undefined): void {
			if (!shouldSend(mark, view, sendFilter)) return;
			channel.postMessage(serializeMarks([stamp(mark, tab)]));
		},
	};
	const detach = runtime.tap(tap);

	let connected = true;
	return (): void => {
		if (!connected) return;
		connected = false;
		detach();
		stopListening();
		channel.close();
	};
}
