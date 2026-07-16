/**
 * Tests FROM packages/react/SPEC.md — R3 (useHandle presence-based
 * registration), including the R3.2 StrictMode contract test. All handles
 * register in provider worlds (per-runtime mediator via mediatorFor) for
 * determinism; module-world binding is covered in provider.test.tsx (R5).
 */
import { describe, expect, it } from "bun:test";
import type { Attempt, IntentName, MediationHandler, MediationResult } from "@telic/core";
import { createTestRuntime } from "@telic/core/testing";
import { useEffect } from "react";
import { TelicProvider, mediatorFor, useHandle } from "./index.js";
import { flush, must, render, renderStrict } from "./test-harness.js";

type MountCapture = { mounts: number };

function HandleProbe(props: {
	readonly name: IntentName;
	readonly handler: MediationHandler;
	readonly capture?: MountCapture;
}): null {
	useHandle(props.name, props.handler);
	const capture = props.capture;
	useEffect((): void => {
		if (capture !== undefined) capture.mounts += 1;
	}, [capture]);
	return null;
}

describe("R3.1 useHandle registers in an effect; cleanup unregisters", () => {
	it("dispatch reaches the handler while mounted; after unmount it rejects TELIC_NO_HANDLER", async () => {
		const t = createTestRuntime();
		const mediator = mediatorFor(t.runtime);
		const received: unknown[] = [];
		const handler: MediationHandler = async (
			_attempt: Attempt<unknown, unknown, unknown>,
			payload: unknown,
		): Promise<MediationResult> => {
			received.push(payload);
			return { ok: true };
		};
		const view = render(
			<TelicProvider runtime={t.runtime}>
				<HandleProbe name="wizard.submitStep" handler={handler} />
			</TelicProvider>,
		);
		const attempt = mediator.dispatch("wizard.submitStep", { step: 1 });
		const settled = await attempt.settled;
		expect(settled.phase).toBe("fulfilled");
		expect(received).toEqual([{ step: 1 }]);

		view.unmount();
		const orphan = mediator.dispatch("wizard.submitStep", { step: 2 });
		const orphanSettled = await orphan.settled;
		expect(orphanSettled.phase).toBe("rejected");
		if (orphanSettled.phase === "rejected") {
			expect(orphanSettled.reason).toEqual({ code: "TELIC_NO_HANDLER" });
		}
		expect(t.diagnostics.filter((d) => d.code === "no-handler").length).toBe(1);
	});

	it("handler identity change re-registers WITHOUT a spurious handler-replaced (latest closure wins)", async () => {
		const t = createTestRuntime();
		const mediator = mediatorFor(t.runtime);
		const calls: string[] = [];
		const handlerA: MediationHandler = async (): Promise<MediationResult> => {
			calls.push("a");
			return { ok: true };
		};
		const handlerB: MediationHandler = async (): Promise<MediationResult> => {
			calls.push("b");
			return { ok: true };
		};
		const view = render(
			<TelicProvider runtime={t.runtime}>
				<HandleProbe name="wizard.saveDraft" handler={handlerA} />
			</TelicProvider>,
		);
		view.rerender(
			<TelicProvider runtime={t.runtime}>
				<HandleProbe name="wizard.saveDraft" handler={handlerB} />
			</TelicProvider>,
		);
		expect(t.diagnostics.filter((d) => d.code === "handler-replaced").length).toBe(0);
		const attempt = mediator.dispatch("wizard.saveDraft", undefined);
		const settled = await attempt.settled;
		expect(settled.phase).toBe("fulfilled");
		expect(calls).toEqual(["b"]);
		view.unmount();
	});
});

describe("R3.2 StrictMode contract: exactly one live registration; parked dispatch drained once", () => {
	it("mount → cleanup → mount ends with one live registration, no handler-replaced, park drained exactly once", async () => {
		const t = createTestRuntime();
		const mediator = mediatorFor(t.runtime);

		// Park a dispatch BEFORE any handler exists (P10b race-absorber).
		const parked = mediator.dispatch("wizard.loadDraft", undefined, { ifUnhandled: "park" });
		expect(parked.phase().phase).toBe("active");

		let handlerCalls = 0;
		const handler: MediationHandler = async (): Promise<MediationResult> => {
			handlerCalls += 1;
			return { ok: true };
		};
		const capture: MountCapture = { mounts: 0 };
		const view = renderStrict(
			<TelicProvider runtime={t.runtime}>
				<HandleProbe name="wizard.loadDraft" handler={handler} capture={capture} />
			</TelicProvider>,
		);
		// Evidence the StrictMode double-mount actually happened (DEV build).
		expect(capture.mounts).toBe(2);

		// The FIRST registration drained the park; the second must not re-execute it.
		const parkedSettled = await parked.settled;
		expect(parkedSettled.phase).toBe("fulfilled");
		expect(handlerCalls).toBe(1);
		expect(t.diagnostics.filter((d) => d.code === "handler-replaced").length).toBe(0);
		expect(t.diagnostics.filter((d) => d.code === "no-handler").length).toBe(0);

		// Exactly one live registration: dispatch works…
		const followUp = mediator.dispatch("wizard.loadDraft", undefined);
		const followUpSettled = await followUp.settled;
		expect(followUpSettled.phase).toBe("fulfilled");
		expect(handlerCalls).toBe(2);
		// …and the runtime's describe() probe reports it (S12.5).
		const descriptor = t.runtime.describe().find((d) => d.name === "wizard.loadDraft");
		expect(must(descriptor).handled).toBe(true);

		// Real unmount removes the single registration.
		view.unmount();
		await flush();
		const after = t.runtime.describe().find((d) => d.name === "wizard.loadDraft");
		expect(must(after).handled).toBe(false);
		const orphan = mediator.dispatch("wizard.loadDraft", undefined);
		const orphanSettled = await orphan.settled;
		expect(orphanSettled.phase).toBe("rejected");
		expect(handlerCalls).toBe(2);
	});
});
