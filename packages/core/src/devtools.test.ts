import { describe, expect, it } from "bun:test";
import type { Runtime } from "./types.js";
import { createRuntime } from "./core.js";
import { mountOverlay } from "./devtools.js";

const NS = "data-telic-devtools";

// ---------------------------------------------------------------------------
// Minimal fake DOM — happy-dom is not resolvable from @telic/core, and S26's
// createElement/appendChild/textContent constraints make a fake sufficient.
// The fake models the two real-DOM behaviours the panel relies on:
//   • setting `textContent` replaces all children (the clear idiom)
//   • `removeChild` detaches, so "unmount removes the node" is observable
// Without these the update/unmount tests would pass by accumulation — a false
// green (they must assert REPLACEMENT and DETACHMENT).
// ---------------------------------------------------------------------------

class FakeElement {
	readonly tag: string;
	readonly attributes: Record<string, string> = {};
	children: FakeElement[] = [];
	parent: FakeElement | undefined;
	readonly ownerDocument: FakeDocument;
	#text = "";

	constructor(tag: string, ownerDocument: FakeDocument) {
		this.tag = tag;
		this.ownerDocument = ownerDocument;
	}

	get textContent(): string {
		return this.#text;
	}

	set textContent(value: string | null) {
		// Real DOM: assigning textContent drops every child and installs one text node.
		this.children = [];
		this.#text = value ?? "";
	}

	setAttribute(name: string, value: string): void {
		this.attributes[name] = value;
	}

	appendChild(child: FakeElement): FakeElement {
		child.parent = this;
		this.children.push(child);
		return child;
	}

	removeChild(child: FakeElement): FakeElement {
		const index = this.children.indexOf(child);
		if (index >= 0) this.children.splice(index, 1);
		child.parent = undefined;
		return child;
	}
}

class FakeDocument {
	readonly body: FakeElement;
	readonly #keyListeners = new Set<(event: { readonly key: string }) => void>();

	constructor() {
		this.body = new FakeElement("body", this);
	}

	createElement(tag: string): FakeElement {
		return new FakeElement(tag, this);
	}

	addEventListener(type: string, listener: (event: { readonly key: string }) => void): void {
		if (type === "keydown") this.#keyListeners.add(listener);
	}

	removeEventListener(_type: string, listener: (event: { readonly key: string }) => void): void {
		this.#keyListeners.delete(listener);
	}

	dispatchKey(key: string): void {
		for (const listener of [...this.#keyListeners]) listener({ key });
	}

	get keyListenerCount(): number {
		return this.#keyListeners.size;
	}
}

function findByRole(root: FakeElement, role: string): FakeElement[] {
	const found: FakeElement[] = [];
	const walk = (element: FakeElement): void => {
		if (element.attributes[NS] === role) found.push(element);
		for (const child of element.children) walk(child);
	};
	walk(root);
	return found;
}

function only(root: FakeElement, role: string): FakeElement {
	const matches = findByRole(root, role);
	if (matches.length !== 1) throw new Error(`expected exactly one "${role}", got ${matches.length}`);
	const first = matches[0];
	if (first === undefined) throw new Error(`no "${role}"`);
	return first;
}

function makeRuntime(): Runtime {
	let counter = 0;
	return createRuntime({
		now: () => 1000,
		id: () => {
			counter += 1;
			return `att-${counter}`;
		},
	});
}

// ---------------------------------------------------------------------------
// S26: mountOverlay
// ---------------------------------------------------------------------------

describe("S26: mountOverlay", () => {
	it("given a container, when mounted with active attempts and marks, then it renders an in-progress row and a tape row per mark", () => {
		const rt = makeRuntime();
		const doc = new FakeDocument();

		const attempt = rt.intent("billing.renew").begin();
		const unmount = mountOverlay(rt, { container: doc.body });

		const panel = only(doc.body, "panel");
		expect(panel.attributes[NS]).toBe("panel");
		expect(findByRole(doc.body, "attempt").length).toBe(1);
		expect(only(doc.body, "attempt").textContent).toContain("billing.renew");
		expect(only(doc.body, "attempt").textContent).toContain(attempt.id);
		// One begun mark on the tape.
		expect(findByRole(doc.body, "mark").length).toBe(1);
		expect(only(doc.body, "mark").textContent).toContain("begun");

		unmount();
	});

	it("given new marks after mount, when the tap fires, then rows are REPLACED not accumulated", () => {
		const rt = makeRuntime();
		const doc = new FakeDocument();
		const unmount = mountOverlay(rt, { container: doc.body });

		expect(findByRole(doc.body, "attempt").length).toBe(0);
		expect(findByRole(doc.body, "mark").length).toBe(0);

		const first = rt.intent("cart.checkout").begin();
		expect(findByRole(doc.body, "attempt").length).toBe(1);
		expect(findByRole(doc.body, "mark").length).toBe(1);

		rt.intent("cart.addItem").begin();
		// Two active attempts, two begun marks — not 1+2 accumulated.
		expect(findByRole(doc.body, "attempt").length).toBe(2);
		expect(findByRole(doc.body, "mark").length).toBe(2);

		// Settling drops it from inProgress but keeps its marks on the tape.
		first.fulfill();
		expect(findByRole(doc.body, "attempt").length).toBe(1);
		expect(findByRole(doc.body, "mark").length).toBe(3); // 2 begun + 1 fulfilled

		unmount();
	});

	it("given more than the tail cap of marks, when rendered, then the tape shows only the last 50", () => {
		const rt = makeRuntime();
		const doc = new FakeDocument();
		const unmount = mountOverlay(rt, { container: doc.body });

		for (let index = 0; index < 55; index += 1) rt.intent("noise.tick").begin();

		expect(findByRole(doc.body, "mark").length).toBe(50);

		unmount();
	});

	it("given unmount, when called, then the panel node is removed and further marks no longer update it", () => {
		const rt = makeRuntime();
		const doc = new FakeDocument();
		const unmount = mountOverlay(rt, { container: doc.body });

		rt.intent("a.one").begin();
		const tapeBefore = findByRole(doc.body, "mark").length;
		expect(doc.body.children.length).toBe(1); // the panel root

		unmount();

		expect(doc.body.children.length).toBe(0); // panel removed
		expect(findByRole(doc.body, "panel").length).toBe(0);

		// Tap detached: new marks must not resurrect or mutate anything.
		rt.intent("a.two").begin();
		expect(findByRole(doc.body, "mark").length).toBe(0);
		expect(tapeBefore).toBe(1);
	});

	it("given no container and no document, when mounted, then it is an inert no-op that unmounts without throwing", () => {
		const rt = makeRuntime();
		// Bun has no global document, so the default-container path is inert.
		const unmount = mountOverlay(rt);
		expect(typeof unmount).toBe("function");
		// Marks still flow through the runtime; the inert overlay ignores them.
		expect(() => rt.intent("ghost.begin").begin()).not.toThrow();
		expect(() => unmount()).not.toThrow();
	});

	it("given a container whose ownerDocument is null and no global document, when mounted, then it is inert", () => {
		const rt = makeRuntime();
		const orphan = { textContent: "", setAttribute(): void {}, appendChild(): void {}, removeChild(): void {}, ownerDocument: null };
		const unmount = mountOverlay(rt, { container: orphan });
		expect(typeof unmount).toBe("function");
		expect(() => unmount()).not.toThrow();
	});

	it("given a hotkey, when pressed, then it toggles the panel display and unmount detaches the listener", () => {
		const rt = makeRuntime();
		const doc = new FakeDocument();
		const unmount = mountOverlay(rt, { container: doc.body, hotkey: "F9" });

		const panel = only(doc.body, "panel");
		expect(panel.attributes.style ?? "").not.toContain("display:none");
		expect(doc.keyListenerCount).toBe(1);

		doc.dispatchKey("F9");
		expect(only(doc.body, "panel").attributes.style ?? "").toContain("display:none");

		doc.dispatchKey("F9");
		expect(only(doc.body, "panel").attributes.style ?? "").not.toContain("display:none");

		// A non-matching key is ignored.
		doc.dispatchKey("Escape");
		expect(only(doc.body, "panel").attributes.style ?? "").not.toContain("display:none");

		unmount();
		expect(doc.keyListenerCount).toBe(0);
	});

	it("the module source never references the forbidden trusted-types DOM sink (S26.2)", async () => {
		const source = await Bun.file(new URL("./devtools.ts", import.meta.url)).text();
		// Needle assembled so neither this test nor the module contains the literal.
		const forbidden = `inner${"HTML"}`;
		expect(source.includes(forbidden)).toBe(false);
	});
});
