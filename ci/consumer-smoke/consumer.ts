/**
 * Consumer smoke: imports the published @telic/core surface (the package entry
 * plus two subpaths) exactly as an external app would, declares an intent with
 * a hand-rolled Standard Schema (no zod, no dependency), and exercises the
 * lifecycle, subscription, and memory APIs. Type-checked against the COMPILED
 * .d.ts under every supported TypeScript version by run.ts.
 */
import { createRuntime, intent, memory, on } from "@telic/core";
import { exposeAgentSurface } from "@telic/core/agent";
import { createConsoleTap } from "@telic/core/taps/console";

/**
 * Minimal structural Standard Schema V1. The spec is types-only and designed to
 * be implemented by hand; this shape structurally satisfies the `StandardSchemaV1`
 * bound that `intent()` accepts, so no schema library is pulled in.
 */
type Schema<T> = {
	readonly "~standard": {
		readonly version: 1;
		readonly vendor: string;
		readonly validate: (
			value: unknown,
		) => { readonly value: T } | { readonly issues: readonly { readonly message: string }[] };
		readonly types?: { readonly input: T; readonly output: T };
	};
};

type CheckoutPayload = { readonly cartId: string };

function isCheckoutPayload(value: unknown): value is CheckoutPayload {
	return (
		typeof value === "object" &&
		value !== null &&
		"cartId" in value &&
		typeof value.cartId === "string"
	);
}

const checkoutSchema: Schema<CheckoutPayload> = {
	"~standard": {
		version: 1,
		vendor: "consumer-smoke",
		validate: (
			value: unknown,
		): { readonly value: CheckoutPayload } | { readonly issues: readonly { readonly message: string }[] } =>
			isCheckoutPayload(value) ? { value } : { issues: [{ message: "expected { cartId: string }" }] },
	},
};

const checkout = intent("checkout.submit", { payload: checkoutSchema });

export function runConsumerSmoke(cartId: string): void {
	// begin/fulfill — payload type flows from the hand-rolled schema.
	const attempt = checkout.begin({ cartId }, { key: cartId, onConflict: "dedupe" });
	const boundCartId: string = attempt.payload.cartId;
	void boundCartId;
	attempt.fulfill();

	// on() with replay — a late subscriber still hears the recent past.
	const unsubscribe = on(
		"checkout.submit",
		(event): void => {
			if (event.mark.kind === "abandoned") {
				// react in real time, for this user
			}
		},
		{ replay: true },
	);
	unsubscribe();

	// memory read surface.
	const active = memory.inProgress();
	void active.length;

	// subpaths: attach the console tap and expose the agent surface on a runtime.
	const runtime = createRuntime();
	const detachTap = runtime.tap(createConsoleTap());
	const detachAgent = exposeAgentSurface(runtime);
	detachTap();
	detachAgent();
}
