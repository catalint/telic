/**
 * Proves that a downstream `declare module` augmentation of `IntentRegistry`
 * merges across the COMPILED declaration boundary — the D18/D19d verification.
 *
 * The proof is fail-closed: if the augmentation did NOT merge, `PayloadFor`
 * resolves to `unknown`, `Equals<unknown, { id: string }>` is `false`, and both
 * the assignment and the return below fail to compile. An assignment INTO a
 * concrete type would silently pass (everything is assignable to `unknown`), so
 * the exact-equality check is what makes absence an error rather than a pass.
 */
import type { IntentTypes, PayloadFor } from "@telic/core";
import { memory, on } from "@telic/core";

declare module "@telic/core" {
	interface IntentRegistry {
		"smoke.test": IntentTypes<{ id: string }>;
	}
}

type Equals<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
	? true
	: false;

// Fails to compile unless the augmentation flowed (else PayloadFor is `unknown`).
const augmentationFlows: Equals<PayloadFor<"smoke.test">, { id: string }> = true;

export function assertRegistryAugmentation(): true {
	// The registered payload type is usable through on() and memory.
	const detach = on("smoke.test", (event): void => {
		const view = event.attempt;
		if (view !== undefined) {
			const id: string = view.payload.id;
			void id;
		}
	});
	detach();

	const latest = memory.last("smoke.test");
	const latestId: string | undefined = latest?.payload.id;
	void latestId;

	return augmentationFlows;
}
