/**
 * Cross-app transport — postMessage (SPEC S23).
 *
 * Bridges two independently-loaded apps/frames on (potentially) different
 * origins, sharing the wire / loop-safety semantics of the BroadcastChannel
 * transport (S22), plus two mandatory guards this cross-origin surface demands:
 * `targetOrigin` is REQUIRED and `"*"` is rejected with a thrown TypeError at
 * connect (a construction-time author error, like the analytics tap's rule
 * validation); and incoming events are dropped unless `accept(event.origin)`
 * passes. All environment touch is feature-detected + structurally injectable
 * (`target` / `listen`) so every path runs under fakes.
 */
import { type CompiledPattern, compilePattern, matchesPattern } from "../pattern.js";
import type {
	IntentPattern,
	Mark,
	MarkOrigin,
	Runtime,
	Tap,
} from "../types.js";
import { parseWirePayload, serializeMarks } from "../wire.js";

const TAP_ID = "transport:post-message";

/** The window/frame to post to: exactly `postMessage(data, targetOrigin)`. */
export type PostMessageTarget = {
	postMessage(data: unknown, targetOrigin: string): void;
};

/** An incoming cross-app message: the wire payload plus the browser-stamped sender origin. */
export type PostMessageEvent = {
	readonly data: unknown;
	readonly origin: string;
};

/** Structural event source for incoming messages; the real `window` satisfies it. */
export type PostMessageListener = {
	addEventListener?(type: "message", handler: (event: PostMessageEvent) => void): void;
	removeEventListener?(type: "message", handler: (event: PostMessageEvent) => void): void;
	onmessage?: ((event: PostMessageEvent) => void) | null;
};

export type ConnectWindowOptions = {
	/** The window/frame to post outgoing marks to. */
	readonly target: PostMessageTarget;
	/** REQUIRED, never defaulted. `"*"` throws a TypeError at connect (author error). */
	readonly targetOrigin: string;
	/** REQUIRED origin allow-list: incoming events whose `origin` fails this are dropped. */
	readonly accept: (origin: string) => boolean;
	/** Incoming event source. Default: `window`, feature-detected. */
	readonly listen?: PostMessageListener;
	/** Outgoing intent-pattern filter. Default: all. */
	readonly send?: readonly IntentPattern[];
	/**
	 * Incoming intent-pattern filter — S22's `accept` patterns, renamed here
	 * because `accept` names the required origin allow-list on this surface.
	 * Default: all.
	 */
	readonly acceptIntents?: readonly IntentPattern[];
	/** This app's id for origin stamping. Default: a fresh generated id. */
	readonly app?: string;
};

// ---------------------------------------------------------------------------
// Structural bridges (sanctioned overload helper — no `as`, mirrors core/wire)
// ---------------------------------------------------------------------------

function asListener(source: Window): PostMessageListener;
function asListener(source: unknown): unknown {
	return source;
}

// ---------------------------------------------------------------------------
// Shared helpers (kept local so this subpath stays independently tree-shakeable)
// ---------------------------------------------------------------------------

function noop(): void {}

function generateAppId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `app-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function compileFilter(
	patterns: readonly IntentPattern[] | undefined,
): readonly CompiledPattern[] | undefined {
	return patterns === undefined ? undefined : patterns.map((pattern) => compilePattern(pattern));
}

function matchesFilter(compiled: readonly CompiledPattern[] | undefined, mark: Mark): boolean {
	return compiled === undefined || compiled.some((pattern) => matchesPattern(pattern, mark.intent));
}

/** Loop safety + send filter — the outgoing gate. */
function shouldSend(
	mark: Mark,
	sendFilter: readonly CompiledPattern[] | undefined,
): boolean {
	if (mark.origin !== undefined) return false; // foreign — never re-send (loop safety)
	return matchesFilter(sendFilter, mark);
}

function stamp(mark: Mark, app: string): Mark {
	const origin: MarkOrigin = { ...mark.origin, app };
	return { ...mark, origin };
}

function listenOn(source: PostMessageListener, handler: (event: PostMessageEvent) => void): () => void {
	if (typeof source.addEventListener === "function") {
		source.addEventListener("message", handler);
		return (): void => {
			source.removeEventListener?.("message", handler);
		};
	}
	source.onmessage = handler;
	return (): void => {
		if (source.onmessage === handler) source.onmessage = null;
	};
}

function resolveListener(listen: PostMessageListener | undefined): PostMessageListener | undefined {
	if (listen !== undefined) return listen;
	if (typeof window !== "undefined") return asListener(window);
	return undefined;
}

// ---------------------------------------------------------------------------
// connectWindow (S23)
// ---------------------------------------------------------------------------

export function connectWindow(runtime: Runtime, opts: ConnectWindowOptions): () => void {
	if (opts.targetOrigin === "*") {
		// The one sanctioned construction-time throw (S23.1): "*" would post to any
		// origin — an author error, not a runtime condition to degrade past.
		throw new TypeError('telic postMessage: targetOrigin "*" is unsafe — specify an explicit origin');
	}
	const app = opts.app ?? generateAppId();
	const targetOrigin = opts.targetOrigin;
	const target = opts.target;
	const acceptOrigin = opts.accept;
	const sendFilter = compileFilter(opts.send);
	const acceptFilter = compileFilter(opts.acceptIntents);

	// Forward-only live gossip: NO onAttach (see the BroadcastChannel transport).
	const tap: Tap = {
		id: TAP_ID,
		onMark(mark: Mark): void {
			if (!shouldSend(mark, sendFilter)) return;
			target.postMessage(serializeMarks([stamp(mark, app)]), targetOrigin);
		},
	};
	const detach = runtime.tap(tap);

	const listener = resolveListener(opts.listen);
	const stopListening =
		listener === undefined
			? noop
			: listenOn(listener, (event: PostMessageEvent): void => {
					if (!acceptOrigin(event.origin)) return; // origin allow-list (S23.2)
					if (typeof event.data !== "string") return; // non-wire dropped silently
					const marks = parseWirePayload(event.data);
					if (marks.length === 0) return; // malformed dropped silently
					const accepted = marks.filter((mark) => matchesFilter(acceptFilter, mark));
					if (accepted.length === 0) return;
					runtime.ingest(accepted);
				});

	let connected = true;
	return (): void => {
		if (!connected) return;
		connected = false;
		detach();
		stopListening();
	};
}
