import { command, dispatch, handle } from "@telic/core";

export function wire(): void {
	command("ops.cleanup"); // no matching handle -> dead-contract (warning)
	handle("ops.reindex", async () => ({ ok: true })); // no command/dispatch -> dead-contract (warning)

	command("ops.migrate"); // matched by handle below -> no finding
	handle("ops.migrate", async () => ({ ok: true }));

	dispatch("ops.notify", {}); // dispatch satisfies the handler below
	handle("ops.notify", async () => ({ ok: true }));
}
