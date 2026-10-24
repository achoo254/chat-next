// The main-thread client shows the notifications its worker asks for, after
// the app's filter: dropped, rewritten or silent, as the filter decides.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationRequest } from "@achoo254/chat-platform";
import { createWebChat, type ShownNotification, type WebChatOptions, type WorkerLike } from "../src/client.ts";
import type { FromWorker } from "../src/protocol.ts";

interface Shown {
	readonly title: string;
	readonly body: string;
	readonly tag: string;
	readonly silent: boolean;
}

class FakeNotification {
	static permission: NotificationPermission = "granted";
	static shown: Shown[] = [];
	onclick: (() => void) | null = null;

	constructor(title: string, options: { body: string; tag: string; silent?: boolean }) {
		FakeNotification.shown.push({ title, body: options.body, tag: options.tag, silent: options.silent === true });
	}

	close(): void {}
}

class FakeWorker implements WorkerLike {
	private listener: ((event: MessageEvent) => void) | null = null;

	postMessage(): void {}

	addEventListener(_type: "message", listener: (event: MessageEvent) => void): void {
		this.listener = listener;
	}

	terminate(): void {}

	send(message: FromWorker): void {
		this.listener?.({ data: message } as MessageEvent);
	}
}

class MemoryStorage {
	private readonly items = new Map<string, string>();
	get length(): number {
		return this.items.size;
	}
	clear(): void {
		this.items.clear();
	}
	getItem(key: string): string | null {
		return this.items.get(key) ?? null;
	}
	key(index: number): string | null {
		return [...this.items.keys()][index] ?? null;
	}
	removeItem(key: string): void {
		this.items.delete(key);
	}
	setItem(key: string, value: string): void {
		this.items.set(key, value);
	}
}

const request: NotificationRequest = { title: "Lan Anh", body: "Mình gửi file thiết kế rồi nhé", tag: "chat:7", chatId: 7 };

function start(options: Partial<WebChatOptions> = {}): FakeWorker {
	const worker = new FakeWorker();
	const chat = createWebChat({
		createWorker: () => worker,
		apiOrigin: "https://chat.example.test",
		appVersion: "test",
		storage: new MemoryStorage(),
		...options,
	});
	cleanup.push(() => chat.dispose());
	return worker;
}

const cleanup: (() => void)[] = [];

beforeEach(() => {
	FakeNotification.shown = [];
	FakeNotification.permission = "granted";
	const listeners = { addEventListener: () => undefined, removeEventListener: () => undefined };
	vi.stubGlobal("Notification", FakeNotification);
	vi.stubGlobal("document", { ...listeners, hidden: false });
	vi.stubGlobal("window", { ...listeners, focus: () => undefined });
	vi.stubGlobal("location", { origin: "https://chat.example.test" });
});

afterEach(() => {
	for (const run of cleanup.splice(0)) run();
	vi.unstubAllGlobals();
});

describe("createWebChat notifications", () => {
	it("shows the core's notification when there is no filter", () => {
		start().send({ type: "notify", request });
		expect(FakeNotification.shown).toEqual([{ title: "Lan Anh", body: "Mình gửi file thiết kế rồi nhé", tag: "chat:7", silent: false }]);
	});

	it("shows what the filter returns, silent when it asks", () => {
		const filterNotification = (incoming: NotificationRequest): ShownNotification => ({ ...incoming, body: "Bạn có tin nhắn mới", silent: true });
		start({ filterNotification }).send({ type: "notify", request });
		expect(FakeNotification.shown).toEqual([{ title: "Lan Anh", body: "Bạn có tin nhắn mới", tag: "chat:7", silent: true }]);
	});

	it("shows nothing when the filter drops it", () => {
		start({ filterNotification: () => null }).send({ type: "notify", request });
		expect(FakeNotification.shown).toEqual([]);
	});

	it("shows nothing and reports when the filter throws", () => {
		const errors: string[] = [];
		const worker = start({
			filterNotification: () => {
				throw new Error("settings not loaded");
			},
			onError: (context, message) => errors.push(`${context}: ${message}`),
		});
		worker.send({ type: "notify", request });
		expect(FakeNotification.shown).toEqual([]);
		expect(errors).toEqual(["notification filter: settings not loaded"]);
	});

	it("does not ask the filter while the browser refuses notifications", () => {
		FakeNotification.permission = "denied";
		const filterNotification = vi.fn((incoming: NotificationRequest) => incoming);
		start({ filterNotification }).send({ type: "notify", request });
		expect(filterNotification).not.toHaveBeenCalled();
		expect(FakeNotification.shown).toEqual([]);
	});
});
