// The Web Push logic behind web-push.ts: the browser's PushManager on one
// side, PushService on the other. webPushWith takes both as parameters so
// the tests drive it with fakes; createWebPushClient wires the real ones.
import { Code, ConnectError, createClient, type Transport } from "@connectrpc/connect";
import { PushService } from "@app/proto-ts/push";
import { isAppleMobile, isStandalone } from "../../install-prompt.ts";
import { pushOnDevice, setPushOnDevice } from "./push-device.ts";
import type { PushLocale, PushStatus, WebPush } from "./web-push.ts";

/** How long to wait for the service worker before giving up (it registers after the first load). */
const WORKER_WAIT_MS = 10_000;

export interface PushSubscriptionLike {
	readonly endpoint: string;
	readonly options: { readonly applicationServerKey: ArrayBuffer | null };
	getKey(name: "p256dh" | "auth"): ArrayBuffer | null;
	unsubscribe(): Promise<boolean>;
}

export interface PushManagerLike {
	getSubscription(): Promise<PushSubscriptionLike | null>;
	subscribe(options: { userVisibleOnly: true; applicationServerKey: Uint8Array<ArrayBuffer> }): Promise<PushSubscriptionLike>;
}

/** The browser side. */
export interface BrowserPush {
	/** Service worker, PushManager and notifications exist. */
	readonly supported: boolean;
	/** Safari on iPhone or iPad outside the installed app. */
	readonly needsInstall: boolean;
	permission(): NotificationPermission;
	requestPermission(): Promise<NotificationPermission>;
	/** The service worker's PushManager; null when no worker controls the app in time. */
	pushManager(): Promise<PushManagerLike | null>;
}

/** The server side (PushService). */
export interface PushServer {
	/** key is empty when the server has Web Push off. */
	config(): Promise<{ key: Uint8Array<ArrayBuffer>; endpoint: string }>;
	register(subscription: { endpoint: string; p256dh: Uint8Array; auth: Uint8Array }, locale: PushLocale): Promise<void>;
	unregister(): Promise<void>;
}

function sameBytes(a: ArrayBuffer | null, b: Uint8Array): boolean {
	if (a === null || a.byteLength !== b.byteLength) return false;
	const view = new Uint8Array(a);
	return view.every((byte, i) => byte === b[i]);
}

function keyOf(subscription: PushSubscriptionLike, name: "p256dh" | "auth"): Uint8Array {
	const key = subscription.getKey(name);
	if (key === null) throw new Error(`push subscription has no ${name} key`);
	return new Uint8Array(key);
}

export function webPushWith(server: PushServer, browser: BrowserPush, selfId: number): WebPush {
	const manager = async (): Promise<PushManagerLike> => {
		const found = await browser.pushManager();
		if (found === null) throw new Error("no service worker controls the app");
		return found;
	};

	/** The browser's subscription for key: kept when made with key, else made again. */
	const subscribeWith = async (pm: PushManagerLike, key: Uint8Array<ArrayBuffer>): Promise<PushSubscriptionLike> => {
		const current = await pm.getSubscription();
		if (current !== null && sameBytes(current.options.applicationServerKey, key)) return current;
		// Made with another key (the server's key changed): push services refuse it now.
		if (current !== null) await current.unsubscribe();
		return pm.subscribe({ userVisibleOnly: true, applicationServerKey: key });
	};

	const register = async (subscription: PushSubscriptionLike, locale: PushLocale): Promise<void> => {
		await server.register({ endpoint: subscription.endpoint, p256dh: keyOf(subscription, "p256dh"), auth: keyOf(subscription, "auth") }, locale);
	};

	/** Turns pushes off on this device: the flag first, so in-app notifications show again at once. */
	const turnOff = async (pm: PushManagerLike | null): Promise<void> => {
		setPushOnDevice(selfId, false);
		const subscription = pm === null ? null : await pm.getSubscription();
		await server.unregister();
		if (subscription !== null) await subscription.unsubscribe();
	};

	const status = async (): Promise<PushStatus> => {
		if (browser.needsInstall) return { kind: "needs-install" };
		if (!browser.supported) return { kind: "unsupported" };
		const { key } = await server.config();
		if (key.byteLength === 0) return { kind: "off" };
		const permission = browser.permission();
		let enabled = false;
		if (permission === "granted" && pushOnDevice(selfId)) {
			const pm = await browser.pushManager();
			enabled = pm !== null && (await pm.getSubscription()) !== null;
		}
		return { kind: "ready", permission, enabled };
	};

	return {
		status,
		async enable(locale) {
			if (browser.needsInstall) return { kind: "needs-install" };
			if (!browser.supported) return { kind: "unsupported" };
			let permission = browser.permission();
			if (permission === "default") permission = await browser.requestPermission();
			if (permission !== "granted") return { kind: "ready", permission, enabled: false };
			const { key } = await server.config();
			if (key.byteLength === 0) return { kind: "off" };
			const subscription = await subscribeWith(await manager(), key);
			await register(subscription, locale);
			setPushOnDevice(selfId, true);
			return { kind: "ready", permission, enabled: true };
		},
		async disable() {
			await turnOff(browser.supported ? await browser.pushManager() : null);
			return status();
		},
		async sync(locale) {
			if (!browser.supported || browser.needsInstall) {
				setPushOnDevice(selfId, false);
				return;
			}
			const pm = await browser.pushManager();
			if (pm === null) return;
			if (!pushOnDevice(selfId)) {
				// Turned off here, or a subscription of another account that
				// used this browser: the server dropped it with that session.
				const leftover = await pm.getSubscription();
				if (leftover !== null) await leftover.unsubscribe();
				return;
			}
			const { key } = await server.config();
			if (browser.permission() !== "granted" || key.byteLength === 0) {
				await turnOff(pm);
				return;
			}
			await register(await subscribeWith(pm, key), locale);
		},
	};
}

function browserPush(): BrowserPush {
	const supported = "serviceWorker" in navigator && typeof window.PushManager !== "undefined" && typeof Notification !== "undefined";
	return {
		supported,
		needsInstall: isAppleMobile() && !isStandalone(),
		permission: () => (typeof Notification === "undefined" ? "denied" : Notification.permission),
		requestPermission: () => Notification.requestPermission(),
		pushManager: () =>
			new Promise((resolve) => {
				const timer = window.setTimeout(() => resolve(null), WORKER_WAIT_MS);
				navigator.serviceWorker.ready.then(
					(registration) => {
						window.clearTimeout(timer);
						resolve(registration.pushManager as unknown as PushManagerLike);
					},
					() => {
						window.clearTimeout(timer);
						resolve(null);
					},
				);
			}),
	};
}

function pushServer(transport: Transport, onUnauthenticated: () => void): PushServer {
	const client = createClient(PushService, transport);
	const call = async <T,>(run: () => Promise<T>): Promise<T> => {
		try {
			return await run();
		} catch (err) {
			if (ConnectError.from(err).code === Code.Unauthenticated) onUnauthenticated();
			throw err;
		}
	};
	return {
		config: () =>
			call(async () => {
				const response = await client.getWebPushConfig({});
				return { key: new Uint8Array(response.applicationServerKey), endpoint: response.endpoint };
			}),
		register: (subscription, locale) =>
			call(async () => {
				await client.registerWebPush({ ...subscription, locale });
			}),
		unregister: () =>
			call(async () => {
				await client.unregisterWebPush({});
			}),
	};
}

export function createWebPushClient(transport: Transport, selfId: number, onUnauthenticated: () => void): WebPush {
	return webPushWith(pushServer(transport, onUnauthenticated), browserPush(), selfId);
}
