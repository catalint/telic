import { describe, expect, it } from "bun:test";
import { createRuntime } from "../core.js";
import type { StandardSchemaV1 } from "../standard-schema.js";
import type { AttemptId, Diagnostic, Exposure, IntentName, Runtime } from "../types.js";
import { serializeMarks } from "../wire.js";
import type { BroadcastChannelLike } from "./broadcast.js";
import { connectBroadcastChannel } from "./broadcast.js";

// ---------------------------------------------------------------------------
// Test infrastructure — a fake BroadcastChannel bus (no self-echo, per-channel
// sent-log) and distinct-id runtimes so cross-runtime attempt ids never collide.
// ---------------------------------------------------------------------------

type ChannelHandler = (event: { readonly data: unknown }) => void;

/** A fake channel that records everything posted through it. */
type SpyChannel = BroadcastChannelLike & { readonly sent: readonly unknown[] };

type BusEntry = {
	readonly listeners: ChannelHandler[];
	onmessage: ChannelHandler | null;
	closed: boolean;
	readonly sent: unknown[];
};

function makeBus(): { channel(): SpyChannel } {
	const entries: BusEntry[] = [];
	function channel(): SpyChannel {
		const entry: BusEntry = { listeners: [], onmessage: null, closed: false, sent: [] };
		entries.push(entry);
		const spy: SpyChannel = {
			sent: entry.sent,
			postMessage(data: unknown): void {
				entry.sent.push(data);
				// Real BroadcastChannel delivers to every OTHER channel, never the sender.
				for (const other of entries) {
					if (other === entry || other.closed) continue;
					other.onmessage?.({ data });
					for (const handler of [...other.listeners]) handler({ data });
				}
			},
			addEventListener(type: "message", handler: ChannelHandler): void {
				if (type === "message") entry.listeners.push(handler);
			},
			removeEventListener(type: "message", handler: ChannelHandler): void {
				if (type !== "message") return;
				const index = entry.listeners.indexOf(handler);
				if (index >= 0) entry.listeners.splice(index, 1);
			},
			close(): void {
				entry.closed = true;
			},
		};
		return spy;
	}
	return { channel };
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

/** Declare (with a payload schema so a payload is accepted) + begin; return the attempt id. */
function begin(runtime: Runtime, name: IntentName, payload: unknown, exposure?: Exposure): AttemptId {
	const intent = runtime.intent(name, {
		payload: passthroughSchema(),
		...(exposure !== undefined ? { exposure } : {}),
	});
	return intent.begin(payload).id;
}

describe("S22 BroadcastChannel transport", () => {
	it("S22: bridges two runtimes both ways, stamps origins, and never loops", () => {
		const bus = makeBus();
		const channelA = bus.channel();
		const channelB = bus.channel();
		const a = makeRuntime("a");
		const b = makeRuntime("b");
		connectBroadcastChannel(a.runtime, { channelFactory: (): SpyChannel => channelA, tab: "tab-A" });
		connectBroadcastChannel(b.runtime, { channelFactory: (): SpyChannel => channelB, tab: "tab-B" });

		// A → B
		begin(a.runtime, "cart.checkout", { items: 2 });
		const seenByB = b.runtime.memory.last("cart.checkout");
		expect(seenByB?.phase).toBe("active");
		expect(seenByB?.origin?.tab).toBe("tab-A"); // origin stamped by A

		// Loop safety: B ingested the mark but must NOT re-broadcast it back.
		expect(channelB.sent.length).toBe(0);
		expect(channelA.sent.length).toBe(1);
		// A did not re-ingest its own attempt: exactly one begun on A's tape.
		expect(a.runtime.memory.marks({ pattern: "cart.*" }).length).toBe(1);

		// B → A (other direction), still no loop back onto A's channel.
		begin(b.runtime, "order.place", { id: 9 });
		const seenByA = a.runtime.memory.last("order.place");
		expect(seenByA?.origin?.tab).toBe("tab-B");
		expect(channelA.sent.length).toBe(1); // A never re-broadcast the foreign order
		expect(channelB.sent.length).toBe(1);
	});

	it("S22.2: send filter — only matching intents leave the runtime", () => {
		const bus = makeBus();
		const a = makeRuntime("a");
		const b = makeRuntime("b");
		connectBroadcastChannel(a.runtime, {
			channelFactory: (): SpyChannel => bus.channel(),
			tab: "tab-A",
			send: ["cart.*"],
		});
		connectBroadcastChannel(b.runtime, { channelFactory: (): SpyChannel => bus.channel(), tab: "tab-B" });

		begin(a.runtime, "cart.checkout", { items: 1 });
		begin(a.runtime, "billing.charge", { amount: 5 });

		expect(b.runtime.memory.last("cart.checkout")).toBeDefined();
		expect(b.runtime.memory.last("billing.charge")).toBeUndefined(); // never sent
	});

	it("S22.3: accept filter — non-matching incoming intents are dropped", () => {
		const bus = makeBus();
		const a = makeRuntime("a");
		const b = makeRuntime("b");
		connectBroadcastChannel(a.runtime, { channelFactory: (): SpyChannel => bus.channel(), tab: "tab-A" });
		connectBroadcastChannel(b.runtime, {
			channelFactory: (): SpyChannel => bus.channel(),
			tab: "tab-B",
			accept: ["cart.*"],
		});

		begin(a.runtime, "cart.checkout", { items: 1 });
		begin(a.runtime, "billing.charge", { amount: 5 });

		expect(b.runtime.memory.last("cart.checkout")).toBeDefined();
		expect(b.runtime.memory.last("billing.charge")).toBeUndefined(); // sent but not accepted
	});

	it("S22.2: exposure — local never leaves (both directions), private travels as placeholder", () => {
		const bus = makeBus();
		const channelA = bus.channel();
		const a = makeRuntime("a");
		const b = makeRuntime("b");
		connectBroadcastChannel(a.runtime, { channelFactory: (): SpyChannel => channelA, tab: "tab-A" });
		connectBroadcastChannel(b.runtime, { channelFactory: (): SpyChannel => bus.channel(), tab: "tab-B" });

		begin(a.runtime, "shop.view", { sku: "abc" });
		begin(a.runtime, "shop.debug", { secret: "xyz" }, "local");
		begin(a.runtime, "shop.pay", { card: "4242" }, "private");

		expect(b.runtime.memory.last("shop.view")?.payload).toEqual({ sku: "abc" });
		expect(b.runtime.memory.last("shop.debug")).toBeUndefined(); // local never sent
		expect(b.runtime.memory.last("shop.pay")?.payload).toBe("[private]");
		// local mark never even hit A's own channel.
		expect(channelA.sent.length).toBe(2);

		// Reverse direction: a local mark on B (a name A never used) does not reach A.
		begin(b.runtime, "audit.trace", { secret: "qqq" }, "local");
		expect(a.runtime.memory.last("audit.trace")).toBeUndefined();
	});

	it("S22.3: malformed incoming is dropped silently", () => {
		const bus = makeBus();
		const receiver = makeRuntime("r");
		connectBroadcastChannel(receiver.runtime, {
			channelFactory: (): SpyChannel => bus.channel(),
			tab: "tab-R",
		});
		const sender = bus.channel();

		sender.postMessage("this is not json");
		sender.postMessage(JSON.stringify({ v: 99, marks: [] })); // unknown version
		sender.postMessage({ not: "a string" });
		sender.postMessage(serializeMarks([])); // valid envelope, no marks

		expect(receiver.runtime.memory.marks().length).toBe(0);
	});

	it("S22.4: disconnect stops flow both ways", () => {
		const bus = makeBus();
		const channelA = bus.channel();
		const a = makeRuntime("a");
		const b = makeRuntime("b");
		const disconnectA = connectBroadcastChannel(a.runtime, {
			channelFactory: (): SpyChannel => channelA,
			tab: "tab-A",
		});
		connectBroadcastChannel(b.runtime, { channelFactory: (): SpyChannel => bus.channel(), tab: "tab-B" });

		disconnectA();

		begin(a.runtime, "cart.checkout", { items: 1 }); // A no longer sends
		expect(b.runtime.memory.last("cart.checkout")).toBeUndefined();
		expect(channelA.sent.length).toBe(0);

		begin(b.runtime, "order.place", { id: 1 }); // A no longer receives
		expect(a.runtime.memory.last("order.place")).toBeUndefined();
	});

	it("S22.2: forward-only — connecting does NOT re-broadcast the pre-existing backlog", () => {
		const bus = makeBus();
		const a = makeRuntime("a");
		const b = makeRuntime("b");
		connectBroadcastChannel(b.runtime, { channelFactory: (): SpyChannel => bus.channel(), tab: "tab-B" });

		// A already has a mark on its tape BEFORE the transport attaches.
		begin(a.runtime, "cart.checkout", { items: 1 });
		connectBroadcastChannel(a.runtime, { channelFactory: (): SpyChannel => bus.channel(), tab: "tab-A" });

		// The backlog must NOT flood B — catch-up is SharedWorker's job, not gossip's.
		expect(b.runtime.memory.last("cart.checkout")).toBeUndefined();

		// …but the transport is live: a NEW mark after connect does propagate.
		begin(a.runtime, "order.place", { id: 1 });
		expect(b.runtime.memory.last("order.place")?.origin?.tab).toBe("tab-A");
	});

	it("S22.1: absent BroadcastChannel → inert + one tap-error diagnostic", () => {
		const saved = globalThis.BroadcastChannel;
		Reflect.deleteProperty(globalThis, "BroadcastChannel");
		try {
			const rt = makeRuntime("u");
			const disconnect = connectBroadcastChannel(rt.runtime, {});
			expect(rt.diagnostics.some((diagnostic) => diagnostic.code === "tap-error")).toBe(true);
			// Inert: recording still works, disconnect is a safe no-op.
			begin(rt.runtime, "cart.checkout", { items: 1 });
			expect(() => disconnect()).not.toThrow();
		} finally {
			globalThis.BroadcastChannel = saved;
		}
	});
});
