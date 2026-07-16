import type { IntentName } from "@telic/core";

// A local, unrelated function that happens to be named `handle`. Because the
// only telic import is TYPE-ONLY (erased at runtime), this file does not use
// telic and must be SKIPPED entirely (L3.1 — no false positives).
function handle(name: IntentName): void {
	void name;
}

export function register(): void {
	handle("orders.setStatus");
}
