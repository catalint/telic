/**
 * Tests FROM packages/react/SPEC.md — R6 (environment: SSR safety, inert
 * server values, no window access, no react-dom runtime dependency —
 * react-dom/server here is a dev-only test harness).
 */
import { describe, expect, it } from "bun:test";
import "./test-setup.js";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Intent, MediationResult } from "@telic/core";
import { configureDefaultRuntime, currentRuntime, intent } from "@telic/core";
import { createTestRuntime, marksOf } from "@telic/core/testing";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import {
	TelicProvider,
	useHandle,
	useInProgress,
	useIntent,
	useLastAttempt,
	useMemorySeq,
} from "./index.js";
import { must } from "./test-harness.js";

function Page(props: { readonly intent: Intent<void, void, unknown> }): ReactElement {
	const seq = useMemorySeq("*");
	const inProgress = useInProgress();
	const last = useLastAttempt("*");
	useIntent(props.intent);
	useHandle(props.intent.name, async (): Promise<MediationResult> => ({ ok: true }));
	return <div>{`seq:${seq};active:${inProgress.length};last:${last === undefined ? "none" : "some"}`}</div>;
}

describe("R6.1 SSR safety: hooks return inert values server-side", () => {
	it("renderToString with a silent provider runtime renders inert values, records nothing, registers nothing", () => {
		const t = createTestRuntime({ mode: "silent" });
		const renderPage = t.runtime.intent("ssr.renderPage");
		const html = renderToString(
			<TelicProvider runtime={t.runtime}>
				<Page intent={renderPage} />
			</TelicProvider>,
		);
		expect(html).toContain("seq:0");
		expect(html).toContain("active:0");
		expect(html).toContain("last:none");
		expect(marksOf(t.runtime).length).toBe(0);
		// Effects never ran: no mediation registration happened (describe() probe, S12.5).
		const descriptor = t.runtime.describe().find((d) => d.name === "ssr.renderPage");
		expect(must(descriptor).handled).toBe(false);
		expect(t.diagnostics.length).toBe(0);
	});

	it("without a provider the module binding is the (silent) default runtime — still inert", () => {
		configureDefaultRuntime({ mode: "silent" });
		const renderPage = intent("ssrmod.renderPage");
		const html = renderToString(<Page intent={renderPage} />);
		expect(html).toContain("seq:0");
		expect(html).toContain("active:0");
		expect(html).toContain("last:none");
		const defaultSeq: number = currentRuntime().seq();
		expect(defaultSeq).toBe(0);
		expect(currentRuntime().memory.marks().length).toBe(0);
	});
});

describe("R6.2 no DOM APIs: works with no window/document at all", () => {
	it("renders inert values with DOM globals removed (hooks never touch window)", async () => {
		const t = createTestRuntime({ mode: "silent" });
		const renderPage = t.runtime.intent("ssrnodom.renderPage");
		await GlobalRegistrator.unregister();
		try {
			expect(typeof document).toBe("undefined");
			expect(typeof window).toBe("undefined");
			const html = renderToString(
				<TelicProvider runtime={t.runtime}>
					<Page intent={renderPage} />
				</TelicProvider>,
			);
			expect(html).toContain("seq:0");
			expect(html).toContain("active:0");
			expect(marksOf(t.runtime).length).toBe(0);
		} finally {
			GlobalRegistrator.register();
			globalThis.IS_REACT_ACT_ENVIRONMENT = true;
		}
	});
});
