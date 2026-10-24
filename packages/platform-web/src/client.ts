// Main-thread side of the web client. It owns no database and decodes no
// protobuf (ADR 0007): it forwards calls to this tab's worker, mirrors the
// change events into a per-frame event bus for React, keeps the cold-start
// snapshot, shows notifications and performs the navigations of sign-in and
// sign-out.
import {
	EventBus,
	EventKeys,
	isAllowedUrl,
	parseSnapshot,
	SIGN_OUT_PATH,
	signInUrl,
	type ScreenSnapshot,
	type SessionEndReason,
} from "@achoo254/chat-core";
import { cryptoRandomId, type FrameScheduler, type NotificationRequest } from "@achoo254/chat-platform";
import {
	CORE_METHODS,
	deserializeError,
	type CoreMethod,
	type FromWorker,
	type NativeConnection,
	type RemoteCore,
	type ToWorker,
} from "./protocol.ts";

/** The part of Worker the client uses (tests pass a fake). */
export interface WorkerLike {
	postMessage(message: ToWorker): void;
	addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
	terminate(): void;
}

export interface WebChatOptions {
	/**
	 * Creates this tab's worker, e.g. with Vite
	 * `import ChatWorker from "@achoo254/chat-client/worker?worker"` and
	 * `() => new ChatWorker()` (the package published from this one).
	 */
	readonly createWorker: () => WorkerLike;
	/**
	 * Origin of the chat server, e.g. `https://chat.example.com`: /rpc and the
	 * realtime gateway (/ws) are reached there. On the web it must be the
	 * page's own origin (the session is a SameSite=Strict HttpOnly cookie):
	 * serve the app from the chat server, or proxy /rpc, /auth, /ws to it.
	 * Only a `native` connection may name another origin.
	 */
	readonly apiOrigin: string;
	readonly appVersion: string;
	/** Defaults to window.localStorage. */
	readonly storage?: Storage;
	readonly onSessionEnded?: (reason: SessionEndReason) => void;
	readonly onNotificationClick?: (chatId: number) => void;
	/**
	 * Decides whether a notification from the core is shown and how: null
	 * drops it, otherwise the returned request (title and body may differ)
	 * is shown. Lets the app apply the user's settings and mutes.
	 */
	readonly filterNotification?: (request: NotificationRequest) => ShownNotification | null;
	readonly onError?: (context: string, message: string) => void;
	/** The native app's session (bearer token); unset on the web (same origin, HttpOnly cookie). */
	readonly native?: NativeConnection;
	/**
	 * Where the browser goes once signOut ended the session; defaults to the
	 * web's sign-out form POST (the server then redirects to the IdP).
	 */
	readonly leave?: () => void;
	/** Extra foreground source (the native app's state, which the WebView's visibility does not follow on Android). */
	readonly onForegroundChange?: (listener: (foreground: boolean) => void) => () => void;
}

/** A notification as shown; `silent` asks the system not to play a sound. */
export interface ShownNotification extends NotificationRequest {
	readonly silent?: boolean;
}

export type TabRole = "starting" | "leader" | "follower";

export type WebChat = RemoteCore & {
	/** Change events, delivered once per animation frame. */
	readonly events: EventBus;
	role(): TabRole;
	/** The last screen of the previous session, for the first paint; null when none. */
	coldSnapshot(): ScreenSnapshot | null;
	/** Stores the current screen for the next cold start. */
	saveSnapshot(): Promise<void>;
	/** Wipes local data, then ends the server session via the sign-out route. */
	signOutAndLeave(): Promise<void>;
	dispose(): void;
};

/** localStorage key of the user whose data this browser holds; removed on sign-out and when the session ends. */
export const LAST_USER_KEY = "chat:last-user";
const snapshotKey = (userId: number): string => `chat:snapshot:${userId}`;

/** Batches per animation frame while visible; hidden tabs get no frames, so fall back to a task. */
const frameScheduler: FrameScheduler = (callback) => {
	if (typeof document !== "undefined" && !document.hidden && typeof requestAnimationFrame === "function") {
		requestAnimationFrame(() => callback());
	} else {
		setTimeout(callback, 0);
	}
};

function readUserId(storage: Storage): number | undefined {
	const raw = storage.getItem(LAST_USER_KEY);
	if (raw === null) return undefined;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Closes the notifications the service worker showed from pushes with this tag (the chat was read or opened). */
function closeWorkerNotifications(tag: string): void {
	if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
	navigator.serviceWorker
		.getRegistration()
		.then((registration) => registration?.getNotifications({ tag }))
		.then((shown) => {
			for (const notification of shown ?? []) notification.close();
		})
		.catch(() => undefined);
}

/**
 * `apiOrigin` as an origin (a trailing slash is dropped). Throws when it is
 * not a bare http(s) origin (the server's routes live at its root, so a
 * path, query or credentials would be lost), or when a web client (no
 * native connection) names another origin than the page's: its cookie
 * session cannot reach it.
 */
export function checkApiOrigin(apiOrigin: string, pageOrigin: string, native: boolean): string {
	let url: URL;
	try {
		url = new URL(apiOrigin);
	} catch {
		throw new TypeError(`apiOrigin must be the chat server's origin, e.g. https://chat.example.com, not "${apiOrigin}"`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new TypeError(`apiOrigin must be an http(s) origin, not "${apiOrigin}"`);
	}
	if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
		throw new TypeError(`apiOrigin must be an origin only (scheme, host, port), e.g. https://chat.example.com, not "${apiOrigin}"`);
	}
	if (!native && url.origin !== pageOrigin) {
		throw new Error(
			`apiOrigin ${url.origin} is not this page's origin ${pageOrigin}: the web client signs in with a same-origin cookie, ` +
				"so serve the app from the chat server or proxy /rpc, /auth and /ws to it",
		);
	}
	return url.origin;
}

export function createWebChat(options: WebChatOptions): WebChat {
	const apiOrigin = checkApiOrigin(options.apiOrigin, location.origin, options.native !== undefined);
	const storage = options.storage ?? window.localStorage;
	const worker = options.createWorker();
	const events = new EventBus(frameScheduler, (err) =>
		options.onError?.("event listener", err instanceof Error ? err.message : String(err)),
	);
	const calls = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	const notifications = new Map<string, Notification>();
	let nextCall = 0;
	let role: TabRole = "starting";
	let userId = readUserId(storage);

	const clearLocal = (): void => {
		if (userId !== undefined) storage.removeItem(snapshotKey(userId));
		storage.removeItem(LAST_USER_KEY);
		userId = undefined;
	};

	const showNotification = (incoming: NotificationRequest): void => {
		if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
		let request: ShownNotification | null = incoming;
		if (options.filterNotification !== undefined) {
			try {
				request = options.filterNotification(incoming);
			} catch (err) {
				// Without a decision the settings may forbid it: show nothing.
				request = null;
				options.onError?.("notification filter", err instanceof Error ? err.message : String(err));
			}
		}
		if (request === null) return;
		notifications.get(request.tag)?.close();
		const notification = new Notification(request.title, { body: request.body, tag: request.tag, silent: request.silent === true });
		notification.onclick = () => {
			window.focus();
			options.onNotificationClick?.(request.chatId);
			notification.close();
		};
		notifications.set(request.tag, notification);
	};

	worker.addEventListener("message", (event) => {
		const message = event.data as FromWorker;
		switch (message.type) {
			case "result": {
				const call = calls.get(message.id);
				if (call === undefined) return;
				calls.delete(message.id);
				if (message.ok) call.resolve(message.value);
				else call.reject(deserializeError(message.error));
				return;
			}
			case "events":
				events.emitAll(message.keys);
				return;
			case "ended":
				clearLocal();
				for (const notification of notifications.values()) notification.close();
				notifications.clear();
				events.emit(EventKeys.session);
				options.onSessionEnded?.(message.reason);
				return;
			case "user":
				if (userId !== undefined && userId !== message.userId) storage.removeItem(snapshotKey(userId));
				userId = message.userId;
				storage.setItem(LAST_USER_KEY, String(message.userId));
				return;
			case "role":
				role = message.role;
				return;
			case "notify":
				showNotification(message.request);
				return;
			case "notify-clear":
				notifications.get(message.tag)?.close();
				notifications.delete(message.tag);
				closeWorkerNotifications(message.tag);
				return;
			case "error":
				options.onError?.(message.context, message.message);
				return;
		}
	});

	const call = (method: CoreMethod, args: unknown[]): Promise<unknown> =>
		new Promise((resolve, reject) => {
			const id = String(++nextCall);
			calls.set(id, { resolve, reject });
			worker.postMessage({ type: "call", id, method, args });
		});

	const onVisibility = (): void => worker.postMessage({ type: "foreground", foreground: !document.hidden });
	const onOnline = (): void => worker.postMessage({ type: "online" });
	// A closing tab hands the database to the next tab; a page kept in the
	// back-forward cache keeps its worker.
	const onPageHide = (event: PageTransitionEvent): void => {
		if (!event.persisted) worker.postMessage({ type: "close" });
	};
	document.addEventListener("visibilitychange", onVisibility);
	window.addEventListener("online", onOnline);
	window.addEventListener("pagehide", onPageHide);
	const stopForeground = options.onForegroundChange?.((foreground) => worker.postMessage({ type: "foreground", foreground }));

	worker.postMessage({
		type: "init",
		config: {
			apiOrigin,
			appVersion: options.appVersion,
			foreground: !document.hidden,
			...(userId === undefined ? {} : { userIdHint: userId }),
			...(options.native === undefined ? {} : { native: options.native }),
		},
	});

	// One forwarding function per core method; the mapped type RemoteCore
	// describes their signatures, which the worker side enforces.
	const remote = Object.fromEntries(
		CORE_METHODS.map((method) => [method, (...args: unknown[]) => call(method, args)]),
	) as unknown as RemoteCore;

	return {
		...remote,
		// A random_id chosen here keeps the send idempotent if the leader tab
		// changes while the call is in flight.
		sendText: (chatId, text, sendOptions) =>
			remote.sendText(chatId, text, { ...sendOptions, randomId: sendOptions?.randomId ?? cryptoRandomId() }),
		sendMedia: (chatId, file, media, sendOptions) =>
			remote.sendMedia(chatId, file, media, { ...sendOptions, randomId: sendOptions?.randomId ?? cryptoRandomId() }),
		sendAlbum: (chatId, items, albumOptions) =>
			remote.sendAlbum(
				chatId,
				items.map((item) => ({ ...item, randomId: item.randomId ?? cryptoRandomId() })),
				albumOptions,
			),
		events,
		role: () => role,
		coldSnapshot: () => {
			if (userId === undefined) return null;
			const raw = storage.getItem(snapshotKey(userId));
			if (raw === null) return null;
			try {
				return parseSnapshot(JSON.parse(raw) as unknown, userId);
			} catch {
				storage.removeItem(snapshotKey(userId));
				return null;
			}
		},
		saveSnapshot: async () => {
			const snapshot = await remote.snapshot();
			storage.setItem(snapshotKey(snapshot.userId), JSON.stringify(snapshot));
		},
		signOutAndLeave: async () => {
			try {
				await remote.signOut();
			} finally {
				clearLocal();
				(options.leave ?? submitSignOut)();
			}
		},
		dispose: () => {
			document.removeEventListener("visibilitychange", onVisibility);
			window.removeEventListener("online", onOnline);
			window.removeEventListener("pagehide", onPageHide);
			stopForeground?.();
			worker.postMessage({ type: "close" });
			worker.terminate();
			for (const pending of calls.values()) pending.reject(new Error("web chat disposed"));
			calls.clear();
		},
	};
}

/** Starts sign-in (or sign-up) at the tenant's IdP in the display language. */
export function goToSignIn(locale: string, create = false): void {
	window.location.assign(signInUrl(locale, { create }));
}

/** POSTs the sign-out form: the server ends the session and redirects to the IdP. */
export function submitSignOut(): void {
	const form = document.createElement("form");
	form.method = "post";
	form.action = SIGN_OUT_PATH;
	document.body.append(form);
	form.submit();
}

/** Opens a link from a message in a new tab, only for allowed schemes (ADR 0004). */
export function openExternal(url: string, appScheme: string): boolean {
	if (!isAllowedUrl(url, appScheme)) return false;
	window.open(url, "_blank", "noopener,noreferrer");
	return true;
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
	if (typeof Notification === "undefined") return "denied";
	return Notification.requestPermission();
}
