import { intent } from "@telic/core";

export function wire(): void {
	intent("checkout.refund"); // scope-ownership: checkout scope, but file is outside src/checkout/**
	intent("billing.charge"); // billing scope is unconfigured; requireScopeOwnership is off -> allowed
}
