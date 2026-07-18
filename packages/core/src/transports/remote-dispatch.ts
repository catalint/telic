/**
 * Cross-realm dispatch — remote-dispatch (SPEC S28, design D34).
 *
 * The REQUEST leg of a command whose handler lives in another realm. The caller
 * owns the channel (`send`); telic only contributes correlation. The RETURN leg
 * is ordinary settlement marks flowing back over the existing mark transports
 * (S22–S24), resolved on the caller by the ingest completion invariant (S10.9).
 *
 * Mediation capabilities (`beginRemote` / `executeRemote`, S15.9) arrive
 * STRUCTURALLY INJECTED so this leaf never imports mediate — its only runtime
 * dependency is the wire codec. No timers, no retries, no reconnection, no
 * diagnostics (S28 preamble); the only state is the `disconnected` flag.
 */
import type { Attempt, DispatchOptions, IntentName, RemoteCorrelation } from "../types.js";
import type { DispatchRequest } from "../wire.js";
import { parseDispatchRequest, serializeDispatchRequest } from "../wire.js";

// ---------------------------------------------------------------------------
// Structural shapes for the injected S15.9 capabilities (never mediate itself)
// ---------------------------------------------------------------------------

/** `beginRemote`-shaped (S15.9): begins a REAL live attempt whose handler lives elsewhere. */
type BeginRemoteFn = (
	name: IntentName,
	payload?: unknown,
	opts?: DispatchOptions,
) => Attempt<unknown, unknown, unknown>;

/** `executeRemote`-shaped (S15.9): runs the world's handler against an attempt adopted on the caller's id. */
type ExecuteRemoteFn = (name: IntentName, payload: unknown, corr: RemoteCorrelation) => void;

// ---------------------------------------------------------------------------
// Caller half — createRemoteDispatcher (S28.1)
// ---------------------------------------------------------------------------

export type CreateRemoteDispatcherOptions = {
	/** An S15.9 `beginRemote`-shaped function (structurally injected). */
	readonly begin: BeginRemoteFn;
	/** The caller's channel — telic never holds a socket. Called synchronously. */
	readonly send: (json: string) => void;
};

export type RemoteDispatcher = {
	dispatch(
		name: IntentName,
		payload?: unknown,
		opts?: DispatchOptions & { ifUnhandled?: "reject" | "park" },
	): Attempt<unknown, unknown, unknown>;
	disconnect(): void;
};

export function createRemoteDispatcher(opts: CreateRemoteDispatcherOptions): RemoteDispatcher {
	const begin = opts.begin;
	const send = opts.send;
	let disconnected = false;

	return {
		dispatch(
			name: IntentName,
			payload?: unknown,
			dispatchOpts?: DispatchOptions & { ifUnhandled?: "reject" | "park" },
		): Attempt<unknown, unknown, unknown> {
			// Recording is truthful even after disconnect: begin the live attempt first.
			const attempt = begin(name, payload, dispatchOpts);
			if (disconnected) {
				// The command observably never left — reject without touching the channel.
				attempt.reject({ code: "TELIC_SEND_FAILED" });
				return attempt;
			}
			const ifUnhandled = dispatchOpts?.ifUnhandled;
			const request: DispatchRequest = {
				intent: name,
				attempt: attempt.id,
				...(payload !== undefined ? { payload } : {}),
				...(ifUnhandled !== undefined ? { ifUnhandled } : {}),
			};
			// Neither encoding nor sending may throw to the dispatcher (S28.1):
			// encode failure is the caller's payload bug, send failure is channel
			// state — distinct codes so the caller can tell them apart.
			let json: string;
			try {
				json = serializeDispatchRequest(request);
			} catch {
				attempt.reject({ code: "TELIC_ENCODE_FAILED" });
				return attempt;
			}
			try {
				send(json);
			} catch {
				attempt.reject({ code: "TELIC_SEND_FAILED" });
			}
			return attempt;
		},
		disconnect(): void {
			disconnected = true;
		},
	};
}

// ---------------------------------------------------------------------------
// Remote half — receiveRemoteDispatches (S28.2)
// ---------------------------------------------------------------------------

/** The minimum an incoming message event exposes; window/MessagePort/BroadcastChannel events satisfy it. */
export type MessageLike = { readonly data: unknown };

/** Structural `message`-event source: a window, a MessagePort, a BroadcastChannel. */
export type RemoteDispatchSource<E extends MessageLike = MessageLike> = {
	addEventListener(type: "message", handler: (event: E) => void): void;
	removeEventListener(type: "message", handler: (event: E) => void): void;
};

export type ReceiveRemoteDispatchesOptions<E extends MessageLike = MessageLike> = {
	/** The `message`-event source to listen on. */
	readonly listen: RemoteDispatchSource<E>;
	/**
	 * Gate over the RAW event — REQUIRED when the source exposes origins (window
	 * `message` events, matching S23.1's allow-listing posture); optional for
	 * origin-less channels (MessagePort, BroadcastChannel).
	 */
	readonly accept?: (event: E) => boolean;
	/** An S15.9 `executeRemote`-shaped function (structurally injected). */
	readonly execute: ExecuteRemoteFn;
};

export function receiveRemoteDispatches<E extends MessageLike = MessageLike>(
	opts: ReceiveRemoteDispatchesOptions<E>,
): () => void {
	const listen = opts.listen;
	const accept = opts.accept;
	const execute = opts.execute;

	const handler = (event: E): void => {
		const data = event.data;
		if (typeof data !== "string") return; // non-string traffic tolerated silently
		const request = parseDispatchRequest(data);
		if (request === undefined) return; // non-request traffic on a shared channel (S19.4 tolerant)
		if (accept !== undefined && !accept(event)) return; // origin/raw-event gate
		const ifUnhandled = request.ifUnhandled;
		execute(request.intent, request.payload, {
			attempt: request.attempt,
			...(ifUnhandled !== undefined ? { ifUnhandled } : {}),
		});
	};
	listen.addEventListener("message", handler);

	return (): void => {
		listen.removeEventListener("message", handler);
	};
}
