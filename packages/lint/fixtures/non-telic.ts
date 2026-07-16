import { handle } from "./local-bus";

// This file never imports from a specifier containing "telic", so its handle()
// call must be SKIPPED entirely (L3.1) — even though the name is setter-like.
export function register(): void {
	handle("orders.setStatus", async () => ({ ok: true }));
}
