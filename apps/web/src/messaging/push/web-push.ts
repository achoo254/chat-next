// Web Push of this device (settings.html#notifications, "Thiết bị này"): the
// browser's push subscription registered for the chat session
// (PushService), so new messages notify while the app is closed. This file
// is the small façade the signed-in app carries; the Connect client, the
// generated schemas and the subscription logic (web-push-client.ts) load on
// the first call.
import type { Transport } from "@connectrpc/connect";
import type { Locale } from "../../i18n/i18n.tsx";
import { IS_NATIVE } from "../../server-origin.ts";

/**
 * What the device can do:
 * - off: the server has Web Push off (no key);
 * - unsupported: this browser cannot receive pushes;
 * - needs-install: Safari on iPhone or iPad outside the installed app;
 * - ready: pushes possible; enabled when this device gets them.
 */
export type PushStatus =
	| { readonly kind: "off" }
	| { readonly kind: "unsupported" }
	| { readonly kind: "needs-install" }
	| { readonly kind: "ready"; readonly permission: NotificationPermission; readonly enabled: boolean };

export interface WebPush {
	status(): Promise<PushStatus>;
	/**
	 * Asks for the notification permission when needed, subscribes and
	 * registers. The server writes notification text in every UI language.
	 */
	enable(locale: Locale): Promise<PushStatus>;
	disable(): Promise<PushStatus>;
	/**
	 * At start: registers the subscription again (a new session after
	 * signing in again, a changed key or language), or drops it when this
	 * device should not get pushes (turned off, permission withdrawn, another
	 * account's subscription).
	 */
	sync(locale: Locale): Promise<void>;
}

export const loadWebPushClient = () => import("./web-push-client.ts");

/** The iOS and Android apps have no Web Push (native push is not built yet): the settings hide it. */
const NO_PUSH: WebPush = {
	status: async () => ({ kind: "off" }),
	enable: async () => ({ kind: "off" }),
	disable: async () => ({ kind: "off" }),
	sync: async () => undefined,
};

export function createWebPush(transport: Transport, selfId: number, onUnauthenticated: () => void): WebPush {
	if (IS_NATIVE) return NO_PUSH;
	let client: Promise<WebPush> | null = null;
	const load = (): Promise<WebPush> => {
		client ??= loadWebPushClient()
			.then((module) => module.createWebPushClient(transport, selfId, onUnauthenticated))
			.catch((err: unknown) => {
				client = null;
				throw err;
			});
		return client;
	};
	return {
		status: () => load().then((push) => push.status()),
		enable: (locale) => load().then((push) => push.enable(locale)),
		disable: () => load().then((push) => push.disable()),
		sync: (locale) => load().then((push) => push.sync(locale)),
	};
}
