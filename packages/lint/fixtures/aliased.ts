import { handle as on, intent as track } from "@telic/core";
import * as telic from "@telic/core";

export function wire(): void {
	track("checkout.updateCart"); // intent via alias -> setter-like: update
	on("checkout.applyCoupon", async () => ({ ok: true })); // handle via alias — clean
	telic.command("checkout.setAddress"); // command via namespace -> setter-like: set
}
