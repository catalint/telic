/**
 * Tests FROM packages/react/SPEC.md — R1 (doctrine: mounts are not intents)
 * and R2 (useIntent stable handle). Renderer stack rationale: test-setup.ts.
 */
import { describe, expect, it } from "bun:test";
import type { Intent } from "@telic/core";
import { createTestRuntime, marksOf } from "@telic/core/testing";
import { act, useEffect } from "react";
import { useIntent } from "./index.js";
import type { UseIntentHandle, UseIntentOptions } from "./index.js";
import { flush, must, render, renderStrict } from "./test-harness.js";

type VoidIntent = Intent<void, void, unknown>;
type VoidHandle = UseIntentHandle<void, void, unknown>;

type ProbeCapture = {
	readonly handles: VoidHandle[];
	mounts: number;
};

function createCapture(): ProbeCapture {
	return { handles: [], mounts: 0 };
}

function IntentProbe(props: {
	readonly intent: VoidIntent;
	readonly capture: ProbeCapture;
	readonly opts?: UseIntentOptions;
}): null {
	const handle = useIntent(props.intent, props.opts);
	props.capture.handles.push(handle);
	const capture = props.capture;
	useEffect((): void => {
		capture.mounts += 1;
	}, [capture]);
	return null;
}

describe("R2.1 useIntent returns { begin, run } stable identities delegating to the intent handle", () => {
	it("keeps the same begin/run references across re-renders", () => {
		const t = createTestRuntime();
		const addItem = t.runtime.intent("cart.addItem");
		const capture = createCapture();
		const view = render(<IntentProbe intent={addItem} capture={capture} />);
		view.rerender(<IntentProbe intent={addItem} capture={capture} />);
		view.rerender(<IntentProbe intent={addItem} capture={capture} />);
		expect(capture.handles.length).toBeGreaterThanOrEqual(3);
		const first = must(capture.handles[0]);
		for (const handle of capture.handles) {
			expect(Object.is(handle, first)).toBe(true);
			expect(Object.is(handle.begin, first.begin)).toBe(true);
			expect(Object.is(handle.run, first.run)).toBe(true);
		}
		view.unmount();
	});

	it("begin delegates to the intent handle (mark lands on the intent's runtime)", () => {
		const t = createTestRuntime();
		const addItem = t.runtime.intent("cart.addItem");
		const capture = createCapture();
		const view = render(<IntentProbe intent={addItem} capture={capture} />);
		const handle = must(capture.handles.at(-1));
		act((): void => {
			const attempt = handle.begin();
			attempt.fulfill();
		});
		const kinds = marksOf(t.runtime, "cart.addItem").map((mark) => mark.kind);
		expect(kinds).toEqual(["begun", "fulfilled"]);
		view.unmount();
	});

	it("run delegates with run() semantics ({ ok: true } fulfills)", async () => {
		const t = createTestRuntime();
		const checkout = t.runtime.intent("cart.checkout");
		const capture = createCapture();
		const view = render(<IntentProbe intent={checkout} capture={capture} />);
		const handle = must(capture.handles.at(-1));
		await act(async (): Promise<void> => {
			const outcome = await handle.run(undefined, async (): Promise<{ ok: boolean }> => {
				return { ok: true };
			});
			expect(outcome.ok).toBe(true);
		});
		const kinds = marksOf(t.runtime, "cart.checkout").map((mark) => mark.kind);
		expect(kinds).toEqual(["begun", "fulfilled"]);
		view.unmount();
	});
});

describe("R2.2 tracked attempts abandon { why: 'unmount' } on unmount", () => {
	it("abandons still-active tracked attempts on unmount", () => {
		const t = createTestRuntime();
		const upload = t.runtime.intent("files.uploadDoc");
		const capture = createCapture();
		const view = render(<IntentProbe intent={upload} capture={capture} />);
		const handle = must(capture.handles.at(-1));
		let attemptPhase = (): string => "unknown";
		act((): void => {
			const attempt = handle.begin();
			attemptPhase = (): string => attempt.phase().phase;
		});
		expect(attemptPhase()).toBe("active");
		view.unmount();
		expect(attemptPhase()).toBe("abandoned");
		const abandoned = marksOf(t.runtime, "files.uploadDoc").filter(
			(mark) => mark.kind === "abandoned",
		);
		expect(abandoned.length).toBe(1);
		const mark = must(abandoned[0]);
		if (mark.kind === "abandoned") expect(mark.abandon).toEqual({ why: "unmount" });
	});

	it("leaves already-settled tracked attempts alone and does not touch untracked attempts", async () => {
		const t = createTestRuntime();
		const upload = t.runtime.intent("files.uploadDoc");
		const capture = createCapture();
		const view = render(<IntentProbe intent={upload} capture={capture} />);
		const handle = must(capture.handles.at(-1));
		act((): void => {
			const attempt = handle.begin();
			attempt.fulfill();
		});
		// Untracked: begun directly on the intent, not through the hook.
		const untracked = upload.begin();
		await flush();
		view.unmount();
		expect(untracked.phase().phase).toBe("active");
		const abandoned = marksOf(t.runtime, "files.uploadDoc").filter(
			(mark) => mark.kind === "abandoned",
		);
		expect(abandoned.length).toBe(0);
	});

	it("abandonOnUnmount: false opts out — attempts stay active after unmount", () => {
		const t = createTestRuntime();
		const sync = t.runtime.intent("drafts.syncDraft");
		const capture = createCapture();
		const view = render(
			<IntentProbe intent={sync} capture={capture} opts={{ abandonOnUnmount: false }} />,
		);
		const handle = must(capture.handles.at(-1));
		let attemptPhase = (): string => "unknown";
		act((): void => {
			const attempt = handle.begin();
			attemptPhase = (): string => attempt.phase().phase;
		});
		view.unmount();
		expect(attemptPhase()).toBe("active");
		const abandoned = marksOf(t.runtime, "drafts.syncDraft").filter(
			(mark) => mark.kind === "abandoned",
		);
		expect(abandoned.length).toBe(0);
	});
});

describe("R2.3 StrictMode contract: the dev double-mount abandons nothing and records nothing", () => {
	it("double-mount alone records NO marks (mounts are not intents, R1)", () => {
		const t = createTestRuntime();
		const renew = t.runtime.intent("billing.renewDomain");
		const capture = createCapture();
		const view = renderStrict(<IntentProbe intent={renew} capture={capture} />);
		// Evidence the StrictMode double-mount actually happened (DEV build).
		expect(capture.mounts).toBe(2);
		expect(marksOf(t.runtime).length).toBe(0);
		expect(t.diagnostics.length).toBe(0);
		view.unmount();
		// Still nothing: no attempt ever existed, so nothing abandoned either.
		expect(marksOf(t.runtime).length).toBe(0);
	});

	it("after the double-mount the handle works and real unmount abandons exactly once", () => {
		const t = createTestRuntime();
		const renew = t.runtime.intent("billing.renewDomain");
		const capture = createCapture();
		const view = renderStrict(<IntentProbe intent={renew} capture={capture} />);
		expect(capture.mounts).toBe(2);
		const handle = must(capture.handles.at(-1));
		act((): void => {
			handle.begin();
		});
		view.unmount();
		const kinds = marksOf(t.runtime, "billing.renewDomain").map((mark) => mark.kind);
		expect(kinds).toEqual(["begun", "abandoned"]);
		const abandoned = must(marksOf(t.runtime, "billing.renewDomain").at(-1));
		if (abandoned.kind === "abandoned") expect(abandoned.abandon).toEqual({ why: "unmount" });
	});
});
