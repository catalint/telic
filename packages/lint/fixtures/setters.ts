import { command, dispatch, handle, intent } from "@telic/core";

export function wire(): void {
	intent("checkout.beginOrder"); // clean — not a setter
	intent("checkout.setEmail"); // setter-like: set
	command("settings.updateTheme"); // setter-like: update
	handle("prefs.toggleDarkMode", async () => ({ ok: true })); // setter-like: toggle
	intent("account.changePassword"); // setter-like: change
	dispatch("checkout.setCoupon", {}); // dispatch is exempt from setter-like-name
}
