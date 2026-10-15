// The service worker's Web Push handlers (src/sw/push-handlers.ts) on a fake
// worker scope: showing a push, opening its chat on click, and registering
// a renewed subscription.
import { describe, expect, it, vi } from "vitest";
import { OPEN_CHAT, openChatId } from "../src/sw/push-messages.ts";
import {
	NOTIFICATION_ICON,
	REGISTER_PATH,
	parsePayload,
	startPushHandlers,
	type NotificationEventLike,
	type PushEventLike,
	type PushScopeLike,
	type PushSubscriptionChangeEventLike,
	type PushWindowLike,
	type ShownOptions,
} from "../src/sw/push-handlers.ts";

const ORIGIN = "https://chat.example.test";

type Listener = (event: never) => void;

class FakeWindow implements PushWindowLike {
	focusedCalls = 0;
	messages: unknown[] = [];
	constructor(
		readonly url: string,
		readonly focused = false,
		readonly visibilityState: DocumentVisibilityState = "hidden",
	) {}
	focus() {
		this.focusedCalls++;
		return Promise.resolve(this);
	}
	postMessage(message: unknown) {
		this.messages.push(message);
	}
}

function scope(windows: FakeWindow[] = []) {
	const listeners = new Map<string, Listener>();
	const shown: { title: string; options: ShownOptions }[] = [];
	const opened: string[] = [];
	const subscribe = vi.fn(() =>
		Promise.resolve({
			endpoint: "https://fcm.googleapis.com/fcm/send/renewed",
			options: { applicationServerKey: new Uint8Array([4, 1]).buffer },
			getKey: (name: "p256dh" | "auth") => new Uint8Array(name === "p256dh" ? [1, 2, 3] : [9]).buffer,
		}),
	);
	const fake = {
		location: { origin: ORIGIN },
		registration: {
			showNotification: (title: string, options: ShownOptions) => {
				shown.push({ title, options });
				return Promise.resolve();
			},
			pushManager: { subscribe },
		},
		clients: {
			matchAll: () => Promise.resolve(windows),
			openWindow: (url: string) => {
				opened.push(url);
				return Promise.resolve(null);
			},
		},
		addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
	};
	const fetch = vi.fn((_input: string, _init: RequestInit) => Promise.resolve(new Response("{}", { status: 200 })));
	startPushHandlers(fake as unknown as PushScopeLike, { fetch, appName: "Chat", fallbackBody: "Bạn có tin nhắn mới" });
	/** Dispatches an event and waits for what it asked to wait for. */
	const fire = async (type: string, event: object): Promise<void> => {
		const pending: Promise<unknown>[] = [];
		const listener = listeners.get(type);
		if (listener === undefined) throw new Error(`no ${type} listener`);
		listener({ ...event, waitUntil: (p: Promise<unknown>) => pending.push(p) } as never);
		await Promise.all(pending);
	};
	return { shown, opened, fetch, subscribe, fire };
}

const payload = { chat_id: 12, title: "Lan Anh", body: "Chào", tag: "chat:12", url: "/c/12", silent: false, ts: 1_760_000_000_000 };
const pushOf = (data: unknown): Omit<PushEventLike, "waitUntil"> => ({ data: { json: () => data } });

describe("push", () => {
	it("shows one notification per chat with the payload", async () => {
		const sw = scope([new FakeWindow(`${ORIGIN}/c/3`, false, "hidden")]);
		await sw.fire("push", pushOf(payload));
		expect(sw.shown).toEqual([
			{
				title: "Lan Anh",
				options: { body: "Chào", tag: "chat:12", icon: NOTIFICATION_ICON, silent: false, renotify: true, timestamp: payload.ts, data: { chatId: 12 } },
			},
		]);
	});

	it("leaves the message to a focused window of the app", async () => {
		const sw = scope([new FakeWindow(`${ORIGIN}/`, true, "visible")]);
		await sw.fire("push", pushOf(payload));
		expect(sw.shown).toEqual([]);
		// A focused window of another origin does not count.
		const other = scope([new FakeWindow("https://elsewhere.test/", true, "visible")]);
		await other.fire("push", pushOf(payload));
		expect(other.shown).toHaveLength(1);
	});

	it("still says a message came when the payload cannot be read", async () => {
		const sw = scope();
		await sw.fire("push", { data: { json: () => JSON.parse("not json") as unknown } });
		await sw.fire("push", pushOf({ ...payload, tag: "chat:13" }));
		await sw.fire("push", { data: null });
		expect(sw.shown.map((n) => [n.title, n.options.body, n.options.tag])).toEqual([
			["Chat", "Bạn có tin nhắn mới", "push"],
			["Chat", "Bạn có tin nhắn mới", "push"],
			["Chat", "Bạn có tin nhắn mới", "push"],
		]);
	});

	it("reads only well-formed payloads", () => {
		expect(parsePayload(payload)).toEqual({ chatId: 12, title: "Lan Anh", body: "Chào", tag: "chat:12", silent: false, timestamp: payload.ts });
		expect(parsePayload({ ...payload, chat_id: 2 ** 53 })).toBeNull();
		expect(parsePayload({ ...payload, chat_id: -1 })).toBeNull();
		expect(parsePayload({ ...payload, title: 1 })).toBeNull();
		expect(parsePayload(null)).toBeNull();
	});
});

describe("notificationclick", () => {
	const click = (chatId: unknown): Omit<NotificationEventLike, "waitUntil"> & { closed: () => boolean } => {
		let closed = false;
		return {
			notification: {
				data: { chatId },
				close: () => {
					closed = true;
				},
			},
			closed: () => closed,
		};
	};

	it("focuses a window of the app and asks it to open the chat", async () => {
		const hidden = new FakeWindow(`${ORIGIN}/c/1`, false, "hidden");
		const visible = new FakeWindow(`${ORIGIN}/settings/profile`, false, "visible");
		const sw = scope([hidden, visible]);
		const event = click(12);
		await sw.fire("notificationclick", event);
		expect(event.closed()).toBe(true);
		expect(visible.focusedCalls).toBe(1);
		expect(visible.messages).toEqual([{ type: OPEN_CHAT, chatId: 12 }]);
		expect(openChatId(visible.messages[0])).toBe(12);
		expect(hidden.focusedCalls).toBe(0);
		expect(sw.opened).toEqual([]);
	});

	it("opens a window on the chat when none is open", async () => {
		const sw = scope([new FakeWindow("https://elsewhere.test/")]);
		await sw.fire("notificationclick", click(12));
		expect(sw.opened).toEqual(["/c/12"]);
		const bad = scope();
		await bad.fire("notificationclick", click("javascript:alert(1)"));
		expect(bad.opened).toEqual(["/"]);
	});
});

describe("pushsubscriptionchange", () => {
	it("subscribes again with the old key and registers the new subscription for the session", async () => {
		const sw = scope();
		const key = new Uint8Array([4, 1]).buffer;
		const event: Omit<PushSubscriptionChangeEventLike, "waitUntil"> = {
			oldSubscription: { endpoint: "https://fcm.googleapis.com/fcm/send/old", options: { applicationServerKey: key }, getKey: () => null },
			newSubscription: null,
		};
		await sw.fire("pushsubscriptionchange", event);
		expect(sw.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: key });
		expect(sw.fetch).toHaveBeenCalledOnce();
		const [path, init] = sw.fetch.mock.calls[0] ?? [];
		expect(path).toBe(REGISTER_PATH);
		expect(init?.credentials).toBe("same-origin");
		expect(JSON.parse(String(init?.body))).toEqual({ endpoint: "https://fcm.googleapis.com/fcm/send/renewed", p256dh: "AQID", auth: "CQ==" });
	});

	it("does nothing without the old key", async () => {
		const sw = scope();
		await sw.fire("pushsubscriptionchange", { oldSubscription: null });
		expect(sw.fetch).not.toHaveBeenCalled();
	});
});
