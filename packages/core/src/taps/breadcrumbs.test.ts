import { describe, expect, it } from "bun:test";
import type { Runtime, Seq } from "../core";
import { createRuntime } from "../core";
import type { StandardSchemaV1 } from "../standard-schema";
import type { BreadcrumbLike } from "./breadcrumbs";
import { createBreadcrumbTap, intentContext } from "./breadcrumbs";

// ---------------------------------------------------------------------------
// Test infrastructure (no external deps; taps run against a REAL runtime).
// ---------------------------------------------------------------------------

function makeRuntime(nowMs: number): { rt: Runtime } {
	let counter = 0;
	const rt = createRuntime({
		now: () => nowMs,
		id: () => {
			counter += 1;
			return `att-${counter}`;
		},
	});
	return { rt };
}

function stringSchema(): StandardSchemaV1<string, string> {
	return {
		"~standard": {
			version: 1,
			vendor: "telic-taps-test",
			validate: (value: unknown): StandardSchemaV1.Result<string> =>
				typeof value === "string" ? { value } : { issues: [{ message: "expected string" }] },
		},
	};
}

function seqNum(seq: Seq): number {
	return seq;
}

function at<T>(items: readonly T[], index: number): T {
	const item = items[index];
	if (item === undefined) throw new Error(`no element at index ${index}`);
	return item;
}

function last<T>(items: readonly T[]): T {
	if (items.length === 0) throw new Error("expected at least one element");
	return at(items, items.length - 1);
}

// ---------------------------------------------------------------------------
// S13.2: breadcrumb tap
// ---------------------------------------------------------------------------

describe("S13.2: breadcrumb tap", () => {
	it("S13.2: given a begun mark, when tapped, then an info breadcrumb carries category, message, timestamp and payload", () => {
		const { rt } = makeRuntime(2500);
		const crumbs: BreadcrumbLike[] = [];
		rt.tap(createBreadcrumbTap({ addBreadcrumb: (crumb) => crumbs.push(crumb) }));
		const attempt = rt.intent("cart.checkout", { payload: stringSchema() }).begin("order-9");
		const crumb = last(crumbs);
		expect(crumb.category).toBe("intent");
		expect(crumb.message).toBe("begun cart.checkout");
		expect(crumb.level).toBe("info");
		expect(crumb.timestamp).toBe(2.5);
		expect(crumb.data.attempt).toBe(attempt.id);
		expect(crumb.data.seq).toBe(1);
		expect(crumb.data.payload).toBe("order-9");
	});

	it("S13.2: given a fulfilled mark, when tapped, then an info breadcrumb carries the outcome", () => {
		const { rt } = makeRuntime(2500);
		const crumbs: BreadcrumbLike[] = [];
		rt.tap(createBreadcrumbTap({ addBreadcrumb: (crumb) => crumbs.push(crumb) }));
		const attempt = rt.intent("op.compute", { fulfilled: stringSchema() }).begin();
		attempt.fulfill("done");
		const crumb = last(crumbs);
		expect(crumb.message).toBe("fulfilled op.compute");
		expect(crumb.level).toBe("info");
		expect(crumb.data.outcome).toBe("done");
	});

	it("S13.2: given a rejected mark, when tapped, then an error breadcrumb carries the reason", () => {
		const { rt } = makeRuntime(2500);
		const crumbs: BreadcrumbLike[] = [];
		rt.tap(createBreadcrumbTap({ addBreadcrumb: (crumb) => crumbs.push(crumb) }));
		const attempt = rt.intent("op.risky").begin();
		attempt.reject("boom");
		const crumb = last(crumbs);
		expect(crumb.message).toBe("rejected op.risky");
		expect(crumb.level).toBe("error");
		expect(crumb.data.reason).toBe("boom");
	});

	it("S13.2: given an abandoned mark, when tapped, then a warning breadcrumb carries the abandon reason", () => {
		const { rt } = makeRuntime(2500);
		const crumbs: BreadcrumbLike[] = [];
		rt.tap(createBreadcrumbTap({ addBreadcrumb: (crumb) => crumbs.push(crumb) }));
		const attempt = rt.intent("upload.file").begin();
		attempt.abandon({ why: "timeout" });
		const crumb = last(crumbs);
		expect(crumb.message).toBe("abandoned upload.file");
		expect(crumb.level).toBe("warning");
		expect(crumb.data.abandon).toEqual({ why: "timeout" });
	});

	it("S13.2: given a noted mark, when tapped, then an info breadcrumb carries the note data", () => {
		const { rt } = makeRuntime(2500);
		const crumbs: BreadcrumbLike[] = [];
		rt.tap(createBreadcrumbTap({ addBreadcrumb: (crumb) => crumbs.push(crumb) }));
		const attempt = rt.intent("wizard.step").begin();
		attempt.note({ step: "review" });
		const crumb = last(crumbs);
		expect(crumb.message).toBe("noted wizard.step");
		expect(crumb.level).toBe("info");
		expect(crumb.data.data).toEqual({ step: "review" });
	});

	it("S13.2: given a linked mark, when tapped, then an info breadcrumb carries the provenance ref", () => {
		const { rt } = makeRuntime(2500);
		const crumbs: BreadcrumbLike[] = [];
		rt.tap(createBreadcrumbTap({ addBreadcrumb: (crumb) => crumbs.push(crumb) }));
		const attempt = rt.intent("mutation.save").begin();
		attempt.link({ kind: "mutation", mutationKey: "saveCart", status: "success" });
		const crumb = last(crumbs);
		expect(crumb.message).toBe("linked mutation.save");
		expect(crumb.level).toBe("info");
		expect(crumb.data.ref).toEqual({
			kind: "mutation",
			mutationKey: "saveCart",
			status: "success",
		});
	});
});

// ---------------------------------------------------------------------------
// S13.2: intentContext enricher
// ---------------------------------------------------------------------------

describe("S13.2: intentContext", () => {
	it("S13.2: given active and settled attempts, when read, then it exposes inProgress and recent marks", () => {
		const { rt } = makeRuntime(2500);
		const flow = rt.intent("nav.step");
		const first = flow.begin();
		flow.begin();
		first.fulfill();
		const context = intentContext(rt.memory);
		expect(context.inProgress.length).toBe(1);
		expect(at(context.inProgress, 0).phase).toBe("active");
		expect(context.recent.length).toBe(3);
	});

	it("S13.2: given more than ten marks, when read, then recent keeps only the last ten in seq order", () => {
		const { rt } = makeRuntime(2500);
		const flow = rt.intent("nav.step");
		for (let index = 0; index < 12; index += 1) flow.begin();
		const context = intentContext(rt.memory);
		expect(context.recent.length).toBe(10);
		expect(seqNum(at(context.recent, 0).seq)).toBe(3);
		expect(seqNum(last(context.recent).seq)).toBe(12);
	});
});
