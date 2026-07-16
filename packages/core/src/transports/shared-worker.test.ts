import { describe, expect, it } from "bun:test";
import { createRuntime } from "../core.js";
import type { StandardSchemaV1 } from "../standard-schema.js";
import type { AttemptId, Diagnostic, Exposure, IntentName, Runtime } from "../types.js";
import type { MessagePortLike } from "./shared-worker.js";
import { connectSharedWorker, createTapeHub } from "./shared-worker.js";

// ---------------------------------------------------------------------------
// Test infrastructure — a fake MessagePort pair (synchronous, cross-wired):
// posting on one end synchronously reaches the handlers registered on the other.
// ---------------------------------------------------------------------------

type PortEvent = { readonly data: unknown };
type PortHandler = (event: PortEvent) => void;

function makeFakePortPair(): { clientPort: MessagePortLike; hubPort: MessagePortLike } {
	const clientListeners: PortHandler[] = [];
	const hubListeners: PortHandler[] = [];
	const makePort = (own: PortHandler[], peers: PortHandler[]): MessagePortLike => ({
		postMessage(data: unknown): void {
			for (const handler of [...peers]) handler({ data });
		},
		addEventListener(type: "message", handler: PortHandler): void {
			if (type === "message") own.push(handler);
		},
		removeEventListener(type: "message", handler: PortHandler): void {
			if (type !== "message") return;
			const index = own.indexOf(handler);
			if (index >= 0) own.splice(index, 1);
		},
		start(): void {},
		close(): void {},
	});
	return {
		clientPort: makePort(clientListeners, hubListeners),
		hubPort: makePort(hubListeners, clientListeners),
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

function begin(runtime: Runtime, name: IntentName, payload: unknown, exposure?: Exposure): AttemptId {
	const intent = runtime.intent(name, {
		payload: passthroughSchema(),
		...(exposure !== undefined ? { exposure } : {}),
	});
	return intent.begin(payload).id;
}

describe("S24 SharedWorker hub transport", () => {
	it("S24.1: a mark from port A reaches B and C plus the hub tape, no loop", () => {
		const hub = makeRuntime("hub");
		const tapeHub = createTapeHub(hub.runtime);
		const pairA = makeFakePortPair();
		const pairB = makeFakePortPair();
		const pairC = makeFakePortPair();
		tapeHub.connect(pairA.hubPort);
		tapeHub.connect(pairB.hubPort);
		tapeHub.connect(pairC.hubPort);

		const a = makeRuntime("a");
		const b = makeRuntime("b");
		const c = makeRuntime("c");
		connectSharedWorker(a.runtime, { port: pairA.clientPort, tab: "tab-A" });
		connectSharedWorker(b.runtime, { port: pairB.clientPort, tab: "tab-B" });
		connectSharedWorker(c.runtime, { port: pairC.clientPort, tab: "tab-C" });

		begin(a.runtime, "cart.checkout", { items: 3 });

		expect(b.runtime.memory.last("cart.checkout")?.origin?.tab).toBe("tab-A");
		expect(c.runtime.memory.last("cart.checkout")?.origin?.tab).toBe("tab-A");
		expect(hub.runtime.memory.last("cart.checkout")?.origin?.tab).toBe("tab-A");
		// A never received its own mark back (fan-out is to OTHER ports only).
		expect(a.runtime.memory.marks({ pattern: "cart.*" }).length).toBe(1);
	});

	it("S24.1: snapshot request is answered with hub-authoritative content", async () => {
		const hub = makeRuntime("hub");
		const tapeHub = createTapeHub(hub.runtime);
		const pairA = makeFakePortPair();
		const pairB = makeFakePortPair();
		tapeHub.connect(pairA.hubPort);
		tapeHub.connect(pairB.hubPort);

		const a = makeRuntime("a");
		const b = makeRuntime("b");
		connectSharedWorker(a.runtime, { port: pairA.clientPort, tab: "tab-A" });
		const bConnection = connectSharedWorker(b.runtime, { port: pairB.clientPort, tab: "tab-B" });

		// An attempt begun via port A, seen authoritatively by the hub…
		begin(a.runtime, "wizard.step", { step: 1 });

		// …is visible in the snapshot the hub returns to port B.
		const snapshot = await bConnection.requestSnapshot();
		const seen = snapshot.active.find((view) => view.intent === "wizard.step");
		expect(seen).toBeDefined();
		expect(seen?.origin?.tab).toBe("tab-A");
	});

	it("S24.2: disconnect stops flow", () => {
		const hub = makeRuntime("hub");
		const tapeHub = createTapeHub(hub.runtime);
		const pairA = makeFakePortPair();
		const pairB = makeFakePortPair();
		tapeHub.connect(pairA.hubPort);
		tapeHub.connect(pairB.hubPort);

		const a = makeRuntime("a");
		const b = makeRuntime("b");
		const aConnection = connectSharedWorker(a.runtime, { port: pairA.clientPort, tab: "tab-A" });
		connectSharedWorker(b.runtime, { port: pairB.clientPort, tab: "tab-B" });

		aConnection.disconnect();
		begin(a.runtime, "cart.checkout", { items: 1 });

		expect(hub.runtime.memory.last("cart.checkout")).toBeUndefined();
		expect(b.runtime.memory.last("cart.checkout")).toBeUndefined();
	});

	it("S24.2: absent SharedWorker (no port/factory) → inert + tap-error, requestSnapshot rejects", async () => {
		const rt = makeRuntime("u");
		const connection = connectSharedWorker(rt.runtime, {});
		expect(rt.diagnostics.some((diagnostic) => diagnostic.code === "tap-error")).toBe(true);
		// Inert: recording still works, disconnect is a safe no-op.
		begin(rt.runtime, "cart.checkout", { items: 1 });
		expect(() => connection.disconnect()).not.toThrow();
		await expect(connection.requestSnapshot()).rejects.toThrow();
	});
});
