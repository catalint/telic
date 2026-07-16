/**
 * Tests FROM packages/react/SPEC.md — R4 (memory subscriptions via
 * useSyncExternalStore, primitive/memoized snapshots, no referential churn).
 */
import { describe, expect, it } from "bun:test";
import type { AttemptView, IntentPattern, Seq } from "@telic/core";
import { createTestRuntime } from "@telic/core/testing";
import { act } from "react";
import { TelicProvider, useInProgress, useLastAttempt, useMemorySeq } from "./index.js";
import { must, render } from "./test-harness.js";

type SeqCapture = { renders: number; seqs: Seq[] };

function SeqProbe(props: {
	readonly pattern?: IntentPattern;
	readonly capture: SeqCapture;
}): null {
	const seq = useMemorySeq(props.pattern);
	props.capture.renders += 1;
	props.capture.seqs.push(seq);
	return null;
}

type ViewsCapture = {
	inProgress: (readonly AttemptView[])[];
	last: (AttemptView | undefined)[];
};

function ViewsProbe(props: {
	readonly capture: ViewsCapture;
	readonly bump: number;
}): null {
	const inProgress = useInProgress("cart.*");
	const last = useLastAttempt("cart.addItem");
	props.capture.inProgress.push(inProgress);
	props.capture.last.push(last);
	return null;
}

describe("R4.1 useMemorySeq re-renders on matching marks; snapshot is the runtime's seq", () => {
	it("matching marks re-render with the runtime's seq; non-matching marks do not re-render", () => {
		const t = createTestRuntime();
		const addItem = t.runtime.intent("cart.addItem");
		const sendPin = t.runtime.intent("auth.sendPin");
		const capture: SeqCapture = { renders: 0, seqs: [] };
		const view = render(
			<TelicProvider runtime={t.runtime}>
				<SeqProbe pattern="cart.*" capture={capture} />
			</TelicProvider>,
		);
		expect(must(capture.seqs.at(-1))).toBe(t.runtime.seq());

		const before = capture.renders;
		act((): void => {
			addItem.begin();
		});
		expect(capture.renders).toBeGreaterThan(before);
		expect(must(capture.seqs.at(-1))).toBe(t.runtime.seq());

		const beforeNonMatching = capture.renders;
		act((): void => {
			sendPin.begin();
		});
		expect(capture.renders).toBe(beforeNonMatching);

		// Next matching mark reflects the full (global) seq again.
		act((): void => {
			addItem.begin();
		});
		expect(must(capture.seqs.at(-1))).toBe(t.runtime.seq());
		expect(typeof must(capture.seqs.at(-1))).toBe("number");
		view.unmount();
	});
});

describe("R4.2 useInProgress / useLastAttempt: memoized reads, recompute only when seq changed", () => {
	it("returns identical references across re-renders without matching marks (no referential churn)", () => {
		const t = createTestRuntime();
		const addItem = t.runtime.intent("cart.addItem");
		const capture: ViewsCapture = { inProgress: [], last: [] };
		const view = render(
			<TelicProvider runtime={t.runtime}>
				<ViewsProbe capture={capture} bump={0} />
			</TelicProvider>,
		);
		act((): void => {
			addItem.begin();
		});
		const stableInProgress = must(capture.inProgress.at(-1));
		const stableLast = capture.last.at(-1);
		expect(stableInProgress.length).toBe(1);

		// Parent-driven re-renders with NO new marks: same references.
		view.rerender(
			<TelicProvider runtime={t.runtime}>
				<ViewsProbe capture={capture} bump={1} />
			</TelicProvider>,
		);
		view.rerender(
			<TelicProvider runtime={t.runtime}>
				<ViewsProbe capture={capture} bump={2} />
			</TelicProvider>,
		);
		expect(Object.is(must(capture.inProgress.at(-1)), stableInProgress)).toBe(true);
		expect(Object.is(capture.last.at(-1), stableLast)).toBe(true);
		view.unmount();
	});

	it("recomputes when a matching mark lands (begin → visible; fulfill → phase advances)", () => {
		const t = createTestRuntime();
		const addItem = t.runtime.intent("cart.addItem");
		const capture: ViewsCapture = { inProgress: [], last: [] };
		const view = render(
			<TelicProvider runtime={t.runtime}>
				<ViewsProbe capture={capture} bump={0} />
			</TelicProvider>,
		);
		expect(must(capture.inProgress.at(-1)).length).toBe(0);
		expect(capture.last.at(-1)).toBeUndefined();

		let fulfillLatest = (): void => {};
		act((): void => {
			const attempt = addItem.begin();
			fulfillLatest = (): void => {
				attempt.fulfill();
			};
		});
		expect(must(capture.inProgress.at(-1)).length).toBe(1);
		expect(must(capture.last.at(-1)).intent).toBe("cart.addItem");
		expect(must(capture.last.at(-1)).phase).toBe("active");

		act((): void => {
			fulfillLatest();
		});
		expect(must(capture.inProgress.at(-1)).length).toBe(0);
		expect(must(capture.last.at(-1)).phase).toBe("fulfilled");
		view.unmount();
	});
});
