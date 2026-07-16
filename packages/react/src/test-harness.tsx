/**
 * Minimal render harness for the spec tests (NOT shipped — excluded from
 * tsconfig.build). See test-setup.ts for the renderer stack rationale.
 */
import "./test-setup.js";
import type { ReactElement } from "react";
import { StrictMode, act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";

export type RenderResult = {
	rerender(element: ReactElement): void;
	unmount(): void;
};

/** Mounts under createRoot inside act(); returns rerender/unmount also act()-wrapped. */
export function render(element: ReactElement): RenderResult {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root: Root = createRoot(container);
	act((): void => {
		root.render(element);
	});
	return {
		rerender: (next: ReactElement): void => {
			act((): void => {
				root.render(next);
			});
		},
		unmount: (): void => {
			act((): void => {
				root.unmount();
			});
			container.remove();
		},
	};
}

/** render() under <React.StrictMode> — the dev double-mount contract surface (R2.3, R3.2). */
export function renderStrict(element: ReactElement): RenderResult {
	return render(<StrictMode>{element}</StrictMode>);
}

/** Drains pending microtasks (settled promises, async handler settlement) inside act(). */
export async function flush(): Promise<void> {
	await act(async (): Promise<void> => {
		await Promise.resolve();
	});
}

/** Narrowing helper: unwraps T | undefined without non-null assertions. */
export function must<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("expected a value, got undefined");
	return value;
}
