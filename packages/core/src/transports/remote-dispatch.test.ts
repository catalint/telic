import { describe, expect, it } from "bun:test";
import { createRuntime } from "../core.js";
import { createMediator } from "../mediate.js";
import type { StandardSchemaV1 } from "../standard-schema.js";
import type {
	Attempt,
	AttemptId,
	Diagnostic,
	DispatchOptions,
	IntentName,
	Mark,
	Mediator,
	RemoteCorrelation,
	Runtime,
} from "../types.js";
import { parseDispatchRequest, serializeDispatchRequest, serializeMarks } from "../wire.js";
import type { MessageLike, RemoteDispatchSource } from "./remote-dispatch.js";
import { createRemoteDispatcher, receiveRemoteDispatches } from "./remote-dispatch.js";

// ---------------------------------------------------------------------------
// Test infrastructure — the real mediate is NOT imported into the caller/remote
// unit halves; structural `begin`/`execute` are injected (S28). The end-to-end
// tests DO wire real createMediator worlds through a fake channel.
// ---------------------------------------------------------------------------

/** Structural `beginRemote` shape (S15.9), injected into the caller half. */
type BeginFn = (
	name: IntentName,
	payload?: unknown,
	opts?: DispatchOptions,
) => Attempt<unknown, unknown, unknown>;

/** Structural `executeRemote` shape (S15.9), injected into the remote half. */
type ExecuteFn = (name: IntentName, payload: unknown, corr: RemoteCorrelation) => void;

type ChannelHandler = (event: MessageLike) => void;

/** A fake `message`-event source with a manual `emit` so tests control delivery ordering. */
function makeChannel(): {
	source: RemoteDispatchSource;
	emit(data: unknown): void;
	listenerCount(): number;
} {
	const handlers: ChannelHandler[] = [];
	return {
		source: {
			addEventListener(type: "message", handler: ChannelHandler): void {
				if (type === "message") handlers.push(handler);
			},
			removeEventListener(type: "message", handler: ChannelHandler): void {
				if (type !== "message") return;
				const index = handlers.indexOf(handler);
				if (index >= 0) handlers.splice(index, 1);
			},
		},
		emit(data: unknown): void {
			for (const handler of [...handlers]) handler({ data });
		},
		listenerCount(): number {
			return handlers.length;
		},
	};
}

function makeRuntime(prefix: string): { runtime: Runtime; diagnostics: Diagnostic[] } {
	const diagnostics: Diagnostic[] = [];
	let counter = 0;
	const runtime = createRuntime({
		now: (): number => 1000,
		id: (): string => {
			counter += 1;
			return `${prefix}${counter}`;
		},
		onDiagnostic: (diagnostic: Diagnostic): void => {
			diagnostics.push(diagnostic);
		},
	});
	return { runtime, diagnostics };
}

function passthroughSchema(): StandardSchemaV1<unknown, unknown> {
	return {
		"~standard": {
			version: 1,
			vendor: "telic-test",
			validate: (value): StandardSchemaV1.Result<unknown> => ({ value }),
		},
	};
}

type BeginCall = {
	readonly name: IntentName;
	readonly payload: unknown;
	readonly opts: DispatchOptions | undefined;
};

/** A `beginRemote`-shaped spy backed by a real runtime so the returned Attempt is real. */
function spyBegin(runtime: Runtime): {
	begin: BeginFn;
	calls: BeginCall[];
	last(): Attempt<unknown, unknown, unknown>;
} {
	const calls: BeginCall[] = [];
	let latest: Attempt<unknown, unknown, unknown> | undefined;
	const begin: BeginFn = (name, payload, opts): Attempt<unknown, unknown, unknown> => {
		calls.push({ name, payload, opts });
		latest = runtime.intent(name, { payload: passthroughSchema() }).begin(payload, opts);
		return latest;
	};
	return {
		begin,
		calls,
		last(): Attempt<unknown, unknown, unknown> {
			if (latest === undefined) throw new Error("begin was not called");
			return latest;
		},
	};
}

type ExecuteCall = {
	readonly name: IntentName;
	readonly payload: unknown;
	readonly corr: RemoteCorrelation;
};

function spyExecute(): { execute: ExecuteFn; calls: ExecuteCall[] } {
	const calls: ExecuteCall[] = [];
	const execute: ExecuteFn = (name, payload, corr): void => {
		calls.push({ name, payload, corr });
	};
	return { execute, calls };
}

/** Mints a real AttemptId (the brand cannot be spelled from a literal). */
function mintAttemptId(prefix: string, name: IntentName): AttemptId {
	return makeRuntime(prefix).runtime.intent(name, { payload: passthroughSchema() }).begin(undefined).id;
}

/** A begun mark for one intent, minted on a throwaway runtime. */
function begunMarkFor(name: IntentName): Mark {
	const runtime = makeRuntime("mark").runtime;
	runtime.intent(name, { payload: passthroughSchema() }).begin({ id: 1 });
	const marks = runtime.memory.marks({ kinds: ["begun"] });
	const begun = marks[0];
	if (begun === undefined) throw new Error("no begun mark minted");
	return begun;
}

// ---------------------------------------------------------------------------
// S28.1 — createRemoteDispatcher (caller half)
// ---------------------------------------------------------------------------

describe("S28.1 createRemoteDispatcher", () => {
	it("S28.1: begins via injected begin, sends the S19.4 envelope, and returns the attempt", () => {
		const caller = makeRuntime("caller");
		const begin = spyBegin(caller.runtime);
		const sent: string[] = [];
		const dispatcher = createRemoteDispatcher({
			begin: begin.begin,
			send: (json): void => {
				sent.push(json);
			},
		});

		const attempt = dispatcher.dispatch("orders.place", { id: 7 });

		expect(begin.calls).toEqual([{ name: "orders.place", payload: { id: 7 }, opts: undefined }]);
		expect(attempt).toBe(begin.last());
		expect(sent.length).toBe(1);
		// The round-trip proves the S19.4 REQUEST envelope was serialized.
		expect(parseDispatchRequest(sent[0] ?? "")).toEqual({
			intent: "orders.place",
			attempt: attempt.id,
			payload: { id: 7 },
		});
	});

	it("S28.1: forwards ifUnhandled onto the wire request", () => {
		const caller = makeRuntime("caller");
		const begin = spyBegin(caller.runtime);
		const sent: string[] = [];
		const dispatcher = createRemoteDispatcher({
			begin: begin.begin,
			send: (json): void => {
				sent.push(json);
			},
		});

		const attempt = dispatcher.dispatch("orders.place", { id: 9 }, { ifUnhandled: "park" });

		expect(parseDispatchRequest(sent[0] ?? "")).toEqual({
			intent: "orders.place",
			attempt: attempt.id,
			payload: { id: 9 },
			ifUnhandled: "park",
		});
	});

	it("S28.1: a synchronous send throw rejects the attempt TELIC_SEND_FAILED", () => {
		const caller = makeRuntime("caller");
		const begin = spyBegin(caller.runtime);
		const dispatcher = createRemoteDispatcher({
			begin: begin.begin,
			send: (): void => {
				throw new Error("channel down");
			},
		});

		const attempt = dispatcher.dispatch("orders.place", { id: 1 });

		const phase = attempt.phase();
		expect(phase.phase).toBe("rejected");
		if (phase.phase === "rejected") expect(phase.reason).toEqual({ code: "TELIC_SEND_FAILED" });
	});

	it("S28.1: after disconnect(), dispatch still begins but rejects without calling send", () => {
		const caller = makeRuntime("caller");
		const begin = spyBegin(caller.runtime);
		const sent: string[] = [];
		const dispatcher = createRemoteDispatcher({
			begin: begin.begin,
			send: (json): void => {
				sent.push(json);
			},
		});

		dispatcher.disconnect();
		const attempt = dispatcher.dispatch("orders.place", { id: 2 });

		// Recording is truthful: begin ran.
		expect(begin.calls.length).toBe(1);
		expect(attempt).toBe(begin.last());
		// The command observably never left.
		expect(sent.length).toBe(0);
		const phase = attempt.phase();
		expect(phase.phase).toBe("rejected");
		if (phase.phase === "rejected") expect(phase.reason).toEqual({ code: "TELIC_SEND_FAILED" });
	});
});

// ---------------------------------------------------------------------------
// S28.2 — receiveRemoteDispatches (remote half)
// ---------------------------------------------------------------------------

describe("S28.2 receiveRemoteDispatches", () => {
	it("S28.2: parses a request and executes with the correct args", () => {
		const channel = makeChannel();
		const execute = spyExecute();
		receiveRemoteDispatches({ listen: channel.source, execute: execute.execute });

		const attemptId = mintAttemptId("req", "orders.place");
		channel.emit(
			serializeDispatchRequest({
				intent: "orders.place",
				attempt: attemptId,
				payload: { id: 3 },
				ifUnhandled: "park",
			}),
		);

		expect(execute.calls.length).toBe(1);
		expect(execute.calls[0]?.name).toBe("orders.place");
		expect(execute.calls[0]?.payload).toEqual({ id: 3 });
		expect(execute.calls[0]?.corr).toEqual({ attempt: attemptId, ifUnhandled: "park" });
	});

	it("S28.2: garbage, non-string, and mark-envelope data never reach execute (disjointness)", () => {
		const channel = makeChannel();
		const execute = spyExecute();
		receiveRemoteDispatches({ listen: channel.source, execute: execute.execute });

		channel.emit("this is not json");
		channel.emit(JSON.stringify({ v: 1, marks: [] })); // a mark envelope, not a dispatch
		channel.emit(serializeMarks([begunMarkFor("orders.place")])); // a real mark envelope
		channel.emit(JSON.stringify({ v: 99, dispatch: {} })); // unknown version
		channel.emit({ data: "not a string" }); // non-string event data
		channel.emit(42);

		expect(execute.calls.length).toBe(0);
	});

	it("S28.2: accept gates over the RAW event and blocks execute when false", () => {
		const channel = makeChannel();
		const execute = spyExecute();
		let seen: MessageLike | undefined;
		receiveRemoteDispatches({
			listen: channel.source,
			accept: (event): boolean => {
				seen = event;
				return false;
			},
			execute: execute.execute,
		});

		const json = serializeDispatchRequest({
			intent: "orders.place",
			attempt: mintAttemptId("req", "orders.place"),
			payload: { id: 4 },
		});
		channel.emit(json);

		expect(execute.calls.length).toBe(0);
		expect(seen).toEqual({ data: json }); // the gate saw the raw event
	});

	it("S28.2: detach removes the listener", () => {
		const channel = makeChannel();
		const execute = spyExecute();
		const detach = receiveRemoteDispatches({ listen: channel.source, execute: execute.execute });

		detach();
		expect(channel.listenerCount()).toBe(0);
		channel.emit(
			serializeDispatchRequest({
				intent: "orders.place",
				attempt: mintAttemptId("req", "orders.place"),
				payload: { id: 5 },
			}),
		);
		expect(execute.calls.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// S28.3 — end-to-end across two real runtimes + createMediator worlds
// ---------------------------------------------------------------------------

/** Two real runtimes with mediation worlds; the remote handles `orders.place`. */
function makeRemotePair(): {
	caller: { runtime: Runtime; diagnostics: Diagnostic[] };
	remote: { runtime: Runtime; diagnostics: Diagnostic[] };
	callerMediator: Mediator;
	remoteMediator: Mediator;
	handlerRuns(): number;
} {
	const caller = makeRuntime("caller");
	const remote = makeRuntime("remote");
	const callerMediator = createMediator(caller.runtime);
	const remoteMediator = createMediator(remote.runtime);
	// Declaring a fulfilled schema on the REMOTE lets the outcome carry data.
	remote.runtime.intent("orders.place", {
		payload: passthroughSchema(),
		fulfilled: passthroughSchema(),
	});
	let runs = 0;
	remoteMediator.handle("orders.place", async (_attempt, payload): Promise<{ ok: true; data: unknown }> => {
		runs += 1;
		return { ok: true, data: { placed: payload } };
	});
	return { caller, remote, callerMediator, remoteMediator, handlerRuns: (): number => runs };
}

/** Simulates the mark transport carrying the remote's terminal mark back to the caller. */
function forwardTerminals(from: Runtime, to: Runtime): () => void {
	return from.tap({
		id: "test:return-leg",
		onMark(mark: Mark): void {
			if (mark.kind === "fulfilled" || mark.kind === "rejected" || mark.kind === "abandoned") {
				to.ingest([mark]);
			}
		},
	});
}

describe("S28.3 remote-dispatch end-to-end", () => {
	it("S28.3: the remote handler settles the caller's live attempt via the return leg (S10.9)", async () => {
		const pair = makeRemotePair();
		const channel = makeChannel();
		receiveRemoteDispatches({ listen: channel.source, execute: pair.remoteMediator.executeRemote });
		const dispatcher = createRemoteDispatcher({
			begin: pair.callerMediator.beginRemote,
			send: (json): void => channel.emit(json),
		});
		const stopReturn = forwardTerminals(pair.remote.runtime, pair.caller.runtime);

		const attempt = dispatcher.dispatch("orders.place", { id: 1 });
		const settled = await attempt.settled;

		expect(pair.handlerRuns()).toBe(1);
		expect(settled.phase).toBe("fulfilled");
		if (settled.phase === "fulfilled") expect(settled.outcome).toEqual({ placed: { id: 1 } });
		stopReturn();
	});

	it("S28.3/S28.5: a begun echoed to the remote BEFORE the request still executes (S15.10 adoption; filtering it is a noise choice, not a correctness requirement)", async () => {
		const pair = makeRemotePair();
		const channel = makeChannel();
		receiveRemoteDispatches({ listen: channel.source, execute: pair.remoteMediator.executeRemote });
		const captured: string[] = [];
		const dispatcher = createRemoteDispatcher({
			begin: pair.callerMediator.beginRemote,
			send: (json): void => {
				captured.push(json); // capture but do NOT deliver yet
			},
		});
		const stopReturn = forwardTerminals(pair.remote.runtime, pair.caller.runtime);

		const attempt = dispatcher.dispatch("orders.place", { id: 42 });

		// Simulate a bidirectional mark transport: the caller's begun, origin-stamped,
		// reaches the remote BEFORE the request envelope arrives.
		const begun = pair.caller.runtime.memory.marks({ pattern: "orders.*", kinds: ["begun"] })[0];
		if (begun === undefined || begun.kind !== "begun") throw new Error("expected a begun mark");
		const stampedBegun: Mark = { ...begun, origin: { tab: "caller" } };
		pair.remote.runtime.ingest([stampedBegun]);

		// Now the request arrives — observing the begin must not block executing it.
		channel.emit(captured[0] ?? "");
		const settled = await attempt.settled;

		expect(pair.handlerRuns()).toBe(1);
		expect(settled.phase).toBe("fulfilled");
		if (settled.phase === "fulfilled") expect(settled.outcome).toEqual({ placed: { id: 42 } });
		stopReturn();
	});

	it("S28.1: a non-serializable payload rejects TELIC_ENCODE_FAILED without throwing and never touches the channel", async () => {
		const pair = makeRemotePair();
		let sends = 0;
		const dispatcher = createRemoteDispatcher({
			begin: pair.callerMediator.beginRemote,
			send: (): void => {
				sends += 1;
			},
		});

		// BigInt is not JSON-serializable: encode throws inside dispatch, never out of it.
		const attempt = dispatcher.dispatch("orders.place", { id: BigInt(7) });
		const settled = await attempt.settled;

		expect(settled.phase).toBe("rejected");
		if (settled.phase === "rejected") expect(settled.reason).toEqual({ code: "TELIC_ENCODE_FAILED" });
		expect(sends).toBe(0);
	});

	it("S28.4: a request fanned to TWO realms runs both handlers but settles the caller once (first terminal wins)", async () => {
		const pairA = makeRemotePair();
		const pairB = makeRemotePair();
		const caller = pairA.caller;
		const callerMediator = pairA.callerMediator;
		const channel = makeChannel();
		// Both remotes listen on the same fanned channel.
		receiveRemoteDispatches({ listen: channel.source, execute: pairA.remoteMediator.executeRemote });
		receiveRemoteDispatches({ listen: channel.source, execute: pairB.remoteMediator.executeRemote });
		const stopA = forwardTerminals(pairA.remote.runtime, caller.runtime);
		const stopB = forwardTerminals(pairB.remote.runtime, caller.runtime);
		const dispatcher = createRemoteDispatcher({
			begin: callerMediator.beginRemote,
			send: (json): void => channel.emit(json),
		});

		const attempt = dispatcher.dispatch("orders.place", { id: 9 });
		const settled = await attempt.settled;

		// Both EXECUTED — the transport does not deduplicate across realms.
		expect(pairA.handlerRuns()).toBe(1);
		expect(pairB.handlerRuns()).toBe(1);
		// ...but settlement is SINGLE: the first terminal wins (S3.4). The tape
		// honestly records BOTH returning terminals (ingest appends every mark);
		// the ATTEMPT settles exactly once and stays settled.
		expect(settled.phase).toBe("fulfilled");
		await Promise.resolve(); // let the second remote's settlement flow back
		expect(
			caller.runtime.memory.marks({ pattern: "orders.*", kinds: ["fulfilled"] }).length,
		).toBe(2);
		expect(attempt.phase().phase).toBe("fulfilled");
		stopA();
		stopB();
	});

	it("S28.3: delivering the same envelope twice runs the handler once (replay dedupe)", async () => {
		const pair = makeRemotePair();
		const channel = makeChannel();
		receiveRemoteDispatches({ listen: channel.source, execute: pair.remoteMediator.executeRemote });
		const captured: string[] = [];
		const dispatcher = createRemoteDispatcher({
			begin: pair.callerMediator.beginRemote,
			send: (json): void => {
				captured.push(json);
				channel.emit(json);
			},
		});
		const stopReturn = forwardTerminals(pair.remote.runtime, pair.caller.runtime);

		const attempt = dispatcher.dispatch("orders.place", { id: 5 });
		channel.emit(captured[0] ?? ""); // replay the identical envelope
		await attempt.settled;

		expect(pair.handlerRuns()).toBe(1);
		stopReturn();
	});
});
