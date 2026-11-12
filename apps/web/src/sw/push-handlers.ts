// Web Push in the service worker (entry: service-worker.ts). The server
// (server/internal/push) sends an encrypted JSON payload per chat when the
// user has no window of the app in the foreground; the browser decrypts it
// and hands it here:
//
// - push: one notification per chat (tag "chat:<id>", the same tag as the
//   in-app notifications, so a newer message replaces the older one), unless
//   a window of the app is focused right now: that window shows the message.
// - notificationclick: focuses a window of the app and asks it to open the
//   chat (push-messages.ts), or opens a new window on /c/<id>.
// - machine pushes (ADR 0013, payload kind "machine"): one per machine (tag
//   "machine:<id>"), no content, only the machine's name and what it waits
//   for; a click opens the machine's waiting session (/ai/<id>/s/<thread>).
//   A usage hint (a running
//   session went past one of the machine's usage rules) comes apart too, one
//   per machine (tag "machine-usage:<id>"), names the machine only, and opens
//   its usage screen (/ai/<id>/usage).
// - a new device of the account (payload kind "account_device_added", tag
//   "account-device:<id>", one per device key): names the device and its
//   platform; a click opens the machines settings with the account's
//   devices (/ai/machines), where it can be revoked.
// - pushsubscriptionchange: the browser renewed the subscription; register
//   the new one for the session (the cookie rides along) over Connect JSON.
//
// The scope and fetch are passed in, so the tests run the handlers on fakes.
import type { ExtendableEventLike } from "./app-shell-worker.ts";
import { OPEN_CHAT, OPEN_PATH, isMachinePath, type OpenChatMessage, type OpenPathMessage } from "./push-messages.ts";

/** The payload of server/internal/push (Payload). */
export interface PushPayload {
	readonly chatId: number;
	readonly title: string;
	readonly body: string;
	readonly tag: string;
	readonly silent: boolean;
	/** Unix milliseconds of the message. */
	readonly timestamp: number;
}

export interface PushEventLike extends ExtendableEventLike {
	readonly data: { json(): unknown } | null;
}

export interface NotificationLike {
	readonly data: unknown;
	close(): void;
}

export interface NotificationEventLike extends ExtendableEventLike {
	readonly notification: NotificationLike;
}

export interface PushSubscriptionLike {
	readonly endpoint: string;
	readonly options: { readonly applicationServerKey: ArrayBuffer | null };
	getKey(name: "p256dh" | "auth"): ArrayBuffer | null;
}

export interface PushSubscriptionChangeEventLike extends ExtendableEventLike {
	readonly oldSubscription?: PushSubscriptionLike | null;
	readonly newSubscription?: PushSubscriptionLike | null;
}

export interface PushWindowLike {
	readonly url: string;
	readonly focused: boolean;
	readonly visibilityState: DocumentVisibilityState;
	focus(): Promise<unknown>;
	postMessage(message: unknown): void;
}

/** What showNotification takes here (the DOM typings miss some fields). */
export interface ShownOptions {
	readonly body: string;
	readonly tag: string;
	readonly icon: string;
	readonly silent: boolean;
	readonly renotify: boolean;
	readonly timestamp: number;
	/** path: set for a machine push, the page its click opens. */
	readonly data: { readonly chatId: number; readonly path?: string };
}

export interface PushScopeLike {
	readonly location: { readonly origin: string };
	readonly registration: {
		showNotification(title: string, options: ShownOptions): Promise<void>;
		readonly pushManager: {
			subscribe(options: { userVisibleOnly: true; applicationServerKey: ArrayBuffer }): Promise<PushSubscriptionLike>;
		};
	};
	readonly clients: {
		matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<readonly PushWindowLike[]>;
		openWindow(url: string): Promise<unknown>;
	};
	addEventListener(type: "push", listener: (event: PushEventLike) => void): void;
	addEventListener(type: "notificationclick", listener: (event: NotificationEventLike) => void): void;
	addEventListener(type: "pushsubscriptionchange", listener: (event: PushSubscriptionChangeEventLike) => void): void;
}

export interface PushDeps {
	readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
	/** Title of a notification whose payload cannot be read (brand pushSenderName). */
	readonly appName: string;
	/** Text of that notification ("Bạn có tin nhắn mới"). */
	readonly fallbackBody: string;
}

/** The notification icon: the brand icon the manifest lists. */
export const NOTIFICATION_ICON = "/icon-192.png";
export const REGISTER_PATH = "/rpc/app.v1.PushService/RegisterWebPush";

function chatPath(chatId: number): string {
	return `/c/${chatId}`;
}

/** Reads a payload; null when it is not one (the notification then says only that a message came). */
export function parsePayload(raw: unknown): PushPayload | null {
	if (typeof raw !== "object" || raw === null) return null;
	const p = raw as Record<string, unknown>;
	const { chat_id: chatId, title, body, tag, silent, ts } = p;
	if (typeof chatId !== "number" || !Number.isSafeInteger(chatId) || chatId <= 0) return null;
	if (typeof title !== "string" || typeof body !== "string" || tag !== `chat:${chatId}`) return null;
	return {
		chatId,
		title,
		body,
		tag,
		silent: silent === true,
		timestamp: typeof ts === "number" && Number.isFinite(ts) ? ts : Date.now(),
	};
}

/** A machine's "needs you" or usage hint push (kind "machine"), or a new device of the account (kind "account_device_added"). */
export interface MachinePushPayload {
	/** 0 for a new device of the account. */
	readonly machineId: number;
	/** The waiting thread; "" when the agent did not say. */
	readonly sessionId: string;
	readonly title: string;
	readonly body: string;
	readonly tag: string;
	readonly timestamp: number;
	/** The page a click opens. */
	readonly path: string;
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The page a new-device push opens: the machines settings, which list the account's devices. */
export const ACCOUNT_DEVICES_PATH = "/ai/machines";
const ACCOUNT_DEVICE_TAG = /^account-device:[1-9][0-9]{0,15}$/;

/** Reads a new-device push; null when it is not one. */
function parseAccountDevicePayload(raw: Record<string, unknown>): MachinePushPayload | null {
	const { title, body, tag, ts } = raw;
	if (typeof title !== "string" || typeof body !== "string" || typeof tag !== "string" || !ACCOUNT_DEVICE_TAG.test(tag)) return null;
	return {
		machineId: 0,
		sessionId: "",
		title,
		body,
		tag,
		timestamp: typeof ts === "number" && Number.isFinite(ts) ? ts : Date.now(),
		path: ACCOUNT_DEVICES_PATH,
	};
}

/** Reads a machine payload (or a new device of the account); null when it is not one. */
export function parseMachinePayload(raw: unknown): MachinePushPayload | null {
	if (typeof raw !== "object" || raw === null) return null;
	const { kind, machine_id: machineId, session_id: sessionId, title, body, tag, ts } = raw as Record<string, unknown>;
	if (kind === "account_device_added") return parseAccountDevicePayload(raw as Record<string, unknown>);
	if (kind !== "machine") return null;
	if (typeof machineId !== "number" || !Number.isSafeInteger(machineId) || machineId <= 0) return null;
	if (typeof title !== "string" || typeof body !== "string") return null;
	const usage = tag === `machine-usage:${machineId}`;
	if (tag !== `machine:${machineId}` && !usage) return null;
	const session = tag === `machine:${machineId}` && typeof sessionId === "string" && SESSION_ID.test(sessionId) ? sessionId : "";
	const path = usage ? `/ai/${machineId}/usage` : session === "" ? `/ai/${machineId}` : `/ai/${machineId}/s/${session}`;
	return {
		machineId,
		sessionId: session,
		title,
		body,
		tag,
		timestamp: typeof ts === "number" && Number.isFinite(ts) ? ts : Date.now(),
		path,
	};
}

function base64(bytes: ArrayBuffer | null): string {
	if (bytes === null) throw new Error("push subscription without keys");
	let binary = "";
	for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
	return btoa(binary);
}

export function startPushHandlers(scope: PushScopeLike, deps: PushDeps): void {
	const windows = async (): Promise<PushWindowLike[]> => {
		const all = await scope.clients.matchAll({ type: "window", includeUncontrolled: true });
		return all.filter((client) => {
			try {
				return new URL(client.url).origin === scope.location.origin;
			} catch {
				return false;
			}
		});
	};

	scope.addEventListener("push", (event) => {
		event.waitUntil(
			(async () => {
				let raw: unknown = null;
				try {
					raw = event.data?.json() ?? null;
				} catch {
					// Not JSON: shown as a plain "new message" below.
				}
				const payload = parsePayload(raw);
				const machine = parseMachinePayload(raw);
				// A focused window of the app shows the message itself.
				if ((await windows()).some((client) => client.focused && client.visibilityState === "visible")) return;
				if (machine !== null) {
					await scope.registration.showNotification(machine.title, {
						body: machine.body,
						tag: machine.tag,
						icon: NOTIFICATION_ICON,
						silent: false,
						renotify: true,
						timestamp: machine.timestamp,
						data: { chatId: 0, path: machine.path },
					});
					return;
				}
				if (payload === null) {
					await scope.registration.showNotification(deps.appName, {
						body: deps.fallbackBody,
						tag: "push",
						icon: NOTIFICATION_ICON,
						silent: false,
						renotify: false,
						timestamp: Date.now(),
						data: { chatId: 0 },
					});
					return;
				}
				await scope.registration.showNotification(payload.title, {
					body: payload.body,
					tag: payload.tag,
					icon: NOTIFICATION_ICON,
					silent: payload.silent,
					// A newer message of the chat alerts again instead of replacing quietly.
					renotify: true,
					timestamp: payload.timestamp,
					data: { chatId: payload.chatId },
				});
			})(),
		);
	});

	scope.addEventListener("notificationclick", (event) => {
		event.notification.close();
		const data = event.notification.data as { chatId?: unknown; path?: unknown } | null;
		const chatId = typeof data?.chatId === "number" && Number.isSafeInteger(data.chatId) && data.chatId > 0 ? data.chatId : 0;
		const path = typeof data?.path === "string" && isMachinePath(data.path) ? data.path : "";
		event.waitUntil(
			(async () => {
				const open = await windows();
				const target = open.find((client) => client.focused) ?? open.find((client) => client.visibilityState === "visible") ?? open[0];
				if (target === undefined) {
					await scope.clients.openWindow(path !== "" ? path : chatId === 0 ? "/" : chatPath(chatId));
					return;
				}
				await target.focus();
				if (path !== "") {
					const message: OpenPathMessage = { type: OPEN_PATH, path };
					target.postMessage(message);
				} else if (chatId !== 0) {
					const message: OpenChatMessage = { type: OPEN_CHAT, chatId };
					target.postMessage(message);
				}
			})(),
		);
	});

	scope.addEventListener("pushsubscriptionchange", (event) => {
		const key = event.oldSubscription?.options.applicationServerKey ?? null;
		event.waitUntil(
			(async () => {
				const renewed =
					event.newSubscription ?? (key === null ? null : await scope.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
				// Without the old key there is nothing to renew: the app subscribes again when opened.
				if (renewed === null) return;
				const response = await deps.fetch(REGISTER_PATH, {
					method: "POST",
					credentials: "same-origin",
					headers: { "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
					body: JSON.stringify({ endpoint: renewed.endpoint, p256dh: base64(renewed.getKey("p256dh")), auth: base64(renewed.getKey("auth")) }),
				});
				if (!response.ok) throw new Error(`registering the renewed push subscription: ${response.status}`);
			})(),
		);
	});
}
