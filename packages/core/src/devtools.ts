/**
 * Devtools overlay (SPEC S26). A plain-DOM panel showing `inProgress()` and a
 * tape tail (last ~50 marks), refreshed by a tap. No framework, no runtime
 * dependency.
 *
 * TRUSTED-TYPES SAFE (S26.2): built exclusively with `createElement` +
 * `textContent` + `setAttribute` + `appendChild`. The DOM sink some CSP
 * policies forbid is never referenced anywhere in this module (a test greps
 * this file to prove it). Setting `textContent = ""` is the clearing idiom —
 * it drops all children without touching that sink.
 *
 * Styling is inline via a single `style` attribute per element (S26.3, no
 * stylesheet injection); every element is namespaced `data-telic-devtools` so
 * a host can restyle or purge the panel.
 *
 * DOM is reached structurally so the panel runs against a real browser
 * document OR a minimal fake (createElement/appendChild/textContent) — the
 * only surface S26 needs.
 */
import type { Runtime } from "./types.js";

// ---------------------------------------------------------------------------
// Structural DOM (matched without depending on lib.dom being the real thing).
// `appendChild`/`removeChild` take `unknown` so a real `Node`-generic DOM and
// a fake both satisfy the type (verified against lib.dom).
// ---------------------------------------------------------------------------

type ElementLike = {
	textContent: string | null;
	setAttribute(name: string, value: string): void;
	appendChild(child: unknown): unknown;
	removeChild(child: unknown): unknown;
	readonly ownerDocument?: DocumentLike | null;
};

type KeyEventLike = {
	readonly key: string;
};

type DocumentLike = {
	createElement(tag: string): ElementLike;
	readonly body?: ElementLike | null;
	addEventListener?(type: string, listener: (event: KeyEventLike) => void): void;
	removeEventListener?(type: string, listener: (event: KeyEventLike) => void): void;
};

export type OverlayOptions = {
	/** Where to mount. Default: `document.body`. Feature-detected — no DOM → inert no-op. */
	readonly container?: ElementLike;
	/** A `KeyboardEvent.key` value that toggles the panel's visibility. Default: none (the host owns visibility). */
	readonly hotkey?: string;
};

const NS = "data-telic-devtools";
const TAIL = 50;

const PANEL_STYLE =
	"position:fixed;bottom:8px;right:8px;width:320px;max-height:50vh;overflow:auto;z-index:2147483647;background:#111;color:#eee;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;padding:8px;border-radius:6px;box-shadow:0 2px 12px rgba(0,0,0,0.4);";
const TITLE_STYLE = "font-weight:600;letter-spacing:0.04em;opacity:0.7;margin-bottom:6px;";
const LABEL_STYLE = "opacity:0.5;text-transform:uppercase;font-size:9px;margin:6px 0 2px;";
const ROW_STYLE = "white-space:pre-wrap;word-break:break-word;padding:1px 0;";

function resolveHost(container: ElementLike | undefined): { doc: DocumentLike; host: ElementLike } | undefined {
	if (container !== undefined) {
		const owner = container.ownerDocument;
		if (owner !== undefined && owner !== null) return { doc: owner, host: container };
		if (typeof document === "undefined") return undefined;
		return { doc: document, host: container };
	}
	if (typeof document === "undefined") return undefined;
	const body = document.body;
	if (body === undefined || body === null) return undefined;
	return { doc: document, host: body };
}

function makeChild(doc: DocumentLike, tag: string, role: string, style: string): ElementLike {
	const element = doc.createElement(tag);
	element.setAttribute(NS, role);
	element.setAttribute("style", style);
	return element;
}

/**
 * S26.1: mounts the overlay and returns an unmount that removes the panel and
 * detaches the tap. Inert (returns a no-op) when no DOM is reachable — costs
 * nothing unless a document exists (S26.4).
 */
export function mountOverlay(runtime: Runtime, opts?: OverlayOptions): () => void {
	const resolved = resolveHost(opts?.container);
	if (resolved === undefined) return (): void => {};
	const { doc, host } = resolved;

	const root = makeChild(doc, "div", "panel", PANEL_STYLE);
	const title = makeChild(doc, "div", "title", TITLE_STYLE);
	title.textContent = "telic";
	const inProgressLabel = makeChild(doc, "div", "label", LABEL_STYLE);
	inProgressLabel.textContent = "in progress";
	const inProgressList = makeChild(doc, "div", "in-progress", "");
	const tapeLabel = makeChild(doc, "div", "label", LABEL_STYLE);
	tapeLabel.textContent = "tape";
	const tapeList = makeChild(doc, "div", "tape", "");

	root.appendChild(title);
	root.appendChild(inProgressLabel);
	root.appendChild(inProgressList);
	root.appendChild(tapeLabel);
	root.appendChild(tapeList);
	host.appendChild(root);

	function render(): void {
		inProgressList.textContent = "";
		for (const view of runtime.memory.inProgress()) {
			const row = makeChild(doc, "div", "attempt", ROW_STYLE);
			row.textContent = `${view.intent} · ${view.id} · ${view.phase}`;
			inProgressList.appendChild(row);
		}
		tapeList.textContent = "";
		const marks = runtime.memory.marks();
		const tail = marks.slice(Math.max(0, marks.length - TAIL));
		for (const mark of tail) {
			const row = makeChild(doc, "div", "mark", ROW_STYLE);
			row.textContent = `#${mark.seq} ${mark.kind} ${mark.intent}`;
			tapeList.appendChild(row);
		}
	}

	const detach = runtime.tap({
		id: "telic-devtools",
		onMark: (): void => {
			render();
		},
	});
	render();

	let visible = true;
	function applyVisibility(): void {
		root.setAttribute("style", visible ? PANEL_STYLE : `${PANEL_STYLE}display:none;`);
	}

	let onKey: ((event: KeyEventLike) => void) | undefined;
	if (opts?.hotkey !== undefined && doc.addEventListener !== undefined) {
		const hotkey = opts.hotkey;
		onKey = (event: KeyEventLike): void => {
			if (event.key !== hotkey) return;
			visible = !visible;
			applyVisibility();
		};
		doc.addEventListener("keydown", onKey);
	}

	return (): void => {
		detach();
		if (onKey !== undefined && doc.removeEventListener !== undefined) {
			doc.removeEventListener("keydown", onKey);
		}
		host.removeChild(root);
	};
}
