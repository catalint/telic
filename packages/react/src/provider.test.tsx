/**
 * Tests FROM packages/react/SPEC.md — R5 (runtime binding: module-level world
 * by default, <TelicProvider runtime={…}> overrides via context).
 *
 * Module-world state (default runtime, module intent registry, module handler
 * registry) is process-global: each test establishes known state via
 * configureDefaultRuntime and uses unique intent scopes (same discipline as
 * core's own mediate tests).
 */
import { describe, expect, it } from "bun:test";
import type {
	Diagnostic,
	IntentName,
	IntentPattern,
	MediationHandler,
	MediationResult,
	Seq,
} from "@telic/core";
import { configureDefaultRuntime, currentRuntime, intent } from "@telic/core";
import { dispatch } from "@telic/core/mediate";
import { createMediator } from "@telic/core/mediate";
import { createTestRuntime } from "@telic/core/testing";
import { act } from "react";
import { TelicProvider, mediatorFor, useHandle, useMemorySeq } from "./index.js";
import { must, render } from "./test-harness.js";

function configureRecordingDefault(): { diagnostics: Diagnostic[] } {
	const diagnostics: Diagnostic[] = [];
	let counter = 0;
	configureDefaultRuntime({
		mode: "record",
		now: (): number => 1000,
		id: (): string => {
			counter += 1;
			return `d${counter}`;
		},
		onDiagnostic: (diagnostic: Diagnostic): void => {
			diagnostics.push(diagnostic);
		},
	});
	return { diagnostics };
}

type SeqCapture = { renders: number; seqs: Seq[] };

function SeqProbe(props: {
	readonly pattern: IntentPattern;
	readonly capture: SeqCapture;
}): null {
	const seq = useMemorySeq(props.pattern);
	props.capture.renders += 1;
	props.capture.seqs.push(seq);
	return null;
}

function HandleProbe(props: {
	readonly name: IntentName;
	readonly handler: MediationHandler;
}): null {
	useHandle(props.name, props.handler);
	return null;
}

describe("R5 hooks bind to the default runtime by default", () => {
	it("useMemorySeq without a provider follows the default runtime's marks", () => {
		configureRecordingDefault();
		const visit = intent("r5home.visitDashboard");
		const capture: SeqCapture = { renders: 0, seqs: [] };
		const view = render(<SeqProbe pattern="r5home.*" capture={capture} />);
		expect(must(capture.seqs.at(-1))).toBe(currentRuntime().seq());
		act((): void => {
			const attempt = visit.begin();
			attempt.fulfill();
		});
		expect(must(capture.seqs.at(-1))).toBe(currentRuntime().seq());
		expect(currentRuntime().seq()).toBeGreaterThan(0);
		view.unmount();
	});

	it("useHandle without a provider registers in the module-level mediation world", async () => {
		configureRecordingDefault();
		const handled: unknown[] = [];
		const handler: MediationHandler = async (
			_attempt,
			payload: unknown,
		): Promise<MediationResult> => {
			handled.push(payload);
			return { ok: true };
		};
		const view = render(<HandleProbe name="r5mod.saveNote" handler={handler} />);
		const attempt = dispatch("r5mod.saveNote", { note: "hi" });
		const settled = await attempt.settled;
		expect(settled.phase).toBe("fulfilled");
		expect(handled).toEqual([{ note: "hi" }]);
		view.unmount();
	});
});

describe("R5 <TelicProvider runtime={…}> overrides via context", () => {
	it("memory hooks follow the provider runtime, not the default runtime", () => {
		configureRecordingDefault();
		const moduleVisit = intent("r5split.visitHome");
		const t = createTestRuntime();
		const providerVisit = t.runtime.intent("r5split.visitHome");
		const capture: SeqCapture = { renders: 0, seqs: [] };
		const view = render(
			<TelicProvider runtime={t.runtime}>
				<SeqProbe pattern="r5split.*" capture={capture} />
			</TelicProvider>,
		);
		// A DEFAULT-runtime mark: matching name, wrong world → no re-render.
		const before = capture.renders;
		act((): void => {
			moduleVisit.begin();
		});
		expect(capture.renders).toBe(before);
		expect(must(capture.seqs.at(-1))).toBe(t.runtime.seq());
		// A PROVIDER-runtime mark re-renders with the provider runtime's seq.
		act((): void => {
			providerVisit.begin();
		});
		expect(capture.renders).toBeGreaterThan(before);
		expect(must(capture.seqs.at(-1))).toBe(t.runtime.seq());
		view.unmount();
	});

	it("useHandle under a provider registers in the per-runtime mediator, invisible to the module world", async () => {
		const { diagnostics } = configureRecordingDefault();
		const t = createTestRuntime();
		const calls: string[] = [];
		const handler: MediationHandler = async (): Promise<MediationResult> => {
			calls.push("provider");
			return { ok: true };
		};
		const view = render(
			<TelicProvider runtime={t.runtime}>
				<HandleProbe name="r5world.syncCart" handler={handler} />
			</TelicProvider>,
		);
		// Provider-world dispatch reaches the component handler.
		const viaProvider = mediatorFor(t.runtime).dispatch("r5world.syncCart", undefined);
		const providerSettled = await viaProvider.settled;
		expect(providerSettled.phase).toBe("fulfilled");
		expect(calls).toEqual(["provider"]);
		// Module-world dispatch of the same name has NO handler (isolated worlds, S15.1).
		const viaModule = dispatch("r5world.syncCart", undefined);
		const moduleSettled = await viaModule.settled;
		expect(moduleSettled.phase).toBe("rejected");
		if (moduleSettled.phase === "rejected") {
			expect(moduleSettled.reason).toEqual({ code: "TELIC_NO_HANDLER" });
		}
		expect(diagnostics.filter((d) => d.code === "no-handler").length).toBe(1);
		view.unmount();
	});

	it("an explicit mediator prop wires useHandle to that mediator", async () => {
		const t = createTestRuntime();
		const explicit = createMediator(t.runtime);
		const calls: string[] = [];
		const handler: MediationHandler = async (): Promise<MediationResult> => {
			calls.push("explicit");
			return { ok: true };
		};
		const view = render(
			<TelicProvider runtime={t.runtime} mediator={explicit}>
				<HandleProbe name="r5explicit.saveCart" handler={handler} />
			</TelicProvider>,
		);
		const attempt = explicit.dispatch("r5explicit.saveCart", undefined);
		const settled = await attempt.settled;
		expect(settled.phase).toBe("fulfilled");
		expect(calls).toEqual(["explicit"]);
		view.unmount();
	});
});
