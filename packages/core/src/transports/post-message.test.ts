import { describe, expect, it } from "bun:test";
import { createRuntime } from "../core.js";
import type { StandardSchemaV1 } from "../standard-schema.js";
import type { AttemptId, Diagnostic, Exposure, IntentName, Runtime } from "../types.js";
import type { PostMessageListener, PostMessageTarget } from "./post-message.js";
import { connectWindow } from "./post-message.js";

// ---------------------------------------------------------------------------
// Test infrastructure — a fake cross-origin frame link. `frameA.target` posts
// to whoever listens on `frameB.listener`, delivering `event.origin = originA`
// (the browser stamps the SENDER's origin on the receiver's event).
// ---------------------------------------------------------------------------

type FrameEvent = { readonly data: unknown; readonly origin: string };
type FrameHandler = (event: FrameEvent) => void;

type Frame = {
	readonly target: PostMessageTarget;
	readonly listener: PostMessageListener;
};

function makeFrameLink(originA: string, originB: string): { frameA: Frame; frameB: Frame } {
	const listenersA: FrameHandler[] = [];
	const listenersB: FrameHandler[] = [];
	const listenerFor = (own: FrameHandler[]): PostMessageListener => ({
		addEventListener(type: "message", handler: FrameHandler): void {
			if (type === "message") own.push(handler);
		},
		removeEventListener(type: "message", handler: FrameHandler): void {
			if (type !== "message") return;
			const index = own.indexOf(handler);
			if (index >= 0) own.splice(index, 1);
		},
	});
	const targetTo = (peers: FrameHandler[], senderOrigin: string): PostMessageTarget => ({
		postMessage(data: unknown, _targetOrigin: string): void {
			for (const handler of [...peers]) handler({ data, origin: senderOrigin });
		},
	});
	return {
		frameA: { target: targetTo(listenersB, originA), listener: listenerFor(listenersA) },
		frameB: { target: targetTo(listenersA, originB), listener: listenerFor(listenersB) },
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

const ORIGIN_A = "https://a.example";
const ORIGIN_B = "https://b.example";

describe("S23 postMessage transport", () => {
	it('S23.1: targetOrigin "*" throws a TypeError at connect', () => {
		const rt = makeRuntime("a");
		const { frameA } = makeFrameLink(ORIGIN_A, ORIGIN_B);
		expect(() =>
			connectWindow(rt.runtime, {
				target: frameA.target,
				targetOrigin: "*",
				accept: (): boolean => true,
			}),
		).toThrow(TypeError);
	});

	it("S23.2: bridges both apps and stamps the app origin when accept(origin) passes", () => {
		const { frameA, frameB } = makeFrameLink(ORIGIN_A, ORIGIN_B);
		const a = makeRuntime("a");
		const b = makeRuntime("b");
		connectWindow(a.runtime, {
			target: frameA.target,
			listen: frameA.listener,
			targetOrigin: ORIGIN_B,
			accept: (origin): boolean => origin === ORIGIN_B,
			app: "app-A",
		});
		connectWindow(b.runtime, {
			target: frameB.target,
			listen: frameB.listener,
			targetOrigin: ORIGIN_A,
			accept: (origin): boolean => origin === ORIGIN_A,
			app: "app-B",
		});

		begin(a.runtime, "deal.open", { id: 1 });
		expect(b.runtime.memory.last("deal.open")?.origin?.app).toBe("app-A");

		begin(b.runtime, "deal.close", { id: 2 });
		expect(a.runtime.memory.last("deal.close")?.origin?.app).toBe("app-B");
	});

	it("S23.2: exposure — local never leaves the runtime, private travels as the placeholder (same semantics as S22)", () => {
		const { frameA, frameB } = makeFrameLink(ORIGIN_A, ORIGIN_B);
		const a = makeRuntime("a");
		const b = makeRuntime("b");
		connectWindow(a.runtime, {
			target: frameA.target,
			listen: frameA.listener,
			targetOrigin: ORIGIN_B,
			accept: (origin): boolean => origin === ORIGIN_B,
			app: "app-A",
		});
		connectWindow(b.runtime, {
			target: frameB.target,
			listen: frameB.listener,
			targetOrigin: ORIGIN_A,
			accept: (origin): boolean => origin === ORIGIN_A,
			app: "app-B",
		});

		begin(a.runtime, "shop.view", { sku: "abc" });
		begin(a.runtime, "shop.debug", { secret: "xyz" }, "local");
		begin(a.runtime, "shop.pay", { card: "4242" }, "private");

		expect(b.runtime.memory.last("shop.view")?.payload).toEqual({ sku: "abc" });
		expect(b.runtime.memory.last("shop.debug")).toBeUndefined(); // local never sent
		expect(b.runtime.memory.last("shop.pay")?.payload).toBe("[private]");
	});

	it("S23.2: incoming from a rejected origin is ignored", () => {
		const { frameA, frameB } = makeFrameLink(ORIGIN_A, ORIGIN_B);
		const a = makeRuntime("a");
		const b = makeRuntime("b");
		connectWindow(a.runtime, {
			target: frameA.target,
			listen: frameA.listener,
			targetOrigin: ORIGIN_B,
			accept: (): boolean => true,
			app: "app-A",
		});
		connectWindow(b.runtime, {
			target: frameB.target,
			listen: frameB.listener,
			targetOrigin: ORIGIN_A,
			accept: (origin): boolean => origin === "https://trusted.example", // NOT origin A
			app: "app-B",
		});

		begin(a.runtime, "deal.open", { id: 1 });
		expect(b.runtime.memory.last("deal.open")).toBeUndefined(); // origin rejected
	});

	it("S23.2: intent send/accept pattern filters apply on top of the origin gate", () => {
		const { frameA, frameB } = makeFrameLink(ORIGIN_A, ORIGIN_B);
		const a = makeRuntime("a");
		const b = makeRuntime("b");
		connectWindow(a.runtime, {
			target: frameA.target,
			listen: frameA.listener,
			targetOrigin: ORIGIN_B,
			accept: (): boolean => true,
			send: ["cart.*"],
		});
		connectWindow(b.runtime, {
			target: frameB.target,
			listen: frameB.listener,
			targetOrigin: ORIGIN_A,
			accept: (origin): boolean => origin === ORIGIN_A,
			acceptIntents: ["cart.*"],
		});

		begin(a.runtime, "cart.checkout", { items: 1 });
		begin(a.runtime, "billing.charge", { amount: 9 }); // filtered out at send

		expect(b.runtime.memory.last("cart.checkout")).toBeDefined();
		expect(b.runtime.memory.last("billing.charge")).toBeUndefined();
	});

	it("S23.2: disconnect stops flow", () => {
		const { frameA, frameB } = makeFrameLink(ORIGIN_A, ORIGIN_B);
		const a = makeRuntime("a");
		const b = makeRuntime("b");
		const disconnectA = connectWindow(a.runtime, {
			target: frameA.target,
			listen: frameA.listener,
			targetOrigin: ORIGIN_B,
			accept: (): boolean => true,
			app: "app-A",
		});
		connectWindow(b.runtime, {
			target: frameB.target,
			listen: frameB.listener,
			targetOrigin: ORIGIN_A,
			accept: (origin): boolean => origin === ORIGIN_A,
			app: "app-B",
		});

		disconnectA();
		begin(a.runtime, "deal.open", { id: 1 });
		expect(b.runtime.memory.last("deal.open")).toBeUndefined();
	});
});
