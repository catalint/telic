import { command, handle, intent } from "@telic/core";

export function wire(): void {
	intent("checkout.beginOrder"); // clean, owned by checkout scope
	intent("checkout.setEmail"); // setter-like-name
	command("checkout.pay"); // paired with the handler below
	handle("checkout.pay", async () => ({ ok: true }));
	handle("checkout.reconcile", async () => ({ ok: true })); // dead-contract: no command/dispatch
}
