// Web Push of this device: the subscription logic on fake browser and server
// sides (messaging/push/web-push-client.ts), the "Thiết bị này" card of the
// notifications tab on the in-memory server, and Settings › Cài ứng dụng.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureInstallPrompt } from "../src/install-prompt.ts";
import { pushOnDevice, setPushOnDevice } from "../src/messaging/push/push-device.ts";
import {
	webPushWith,
	type BrowserPush,
	type PushManagerLike,
	type PushServer,
	type PushSubscriptionLike,
} from "../src/messaging/push/web-push-client.ts";
import { seedDemo } from "./support/demo-data.ts";
import { FAKE_PUSH_KEY } from "./support/fake-push.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const SELF = 42;
const LONG = { timeout: 8000 };

/** A browser's PushManager that hands out numbered subscriptions. */
class FakePushManager implements PushManagerLike {
	current: (PushSubscriptionLike & { unsubscribed: boolean }) | null = null;
	made = 0;

	getSubscription(): Promise<PushSubscriptionLike | null> {
		return Promise.resolve(this.current);
	}

	subscribe(options: { userVisibleOnly: true; applicationServerKey: Uint8Array<ArrayBuffer> }): Promise<PushSubscriptionLike> {
		const n = ++this.made;
		const key = options.applicationServerKey.slice().buffer;
		const sub = {
			endpoint: `https://fcm.googleapis.com/fcm/send/sub-${n}`,
			options: { applicationServerKey: key },
			unsubscribed: false,
			getKey: (name: "p256dh" | "auth") => new Uint8Array(name === "p256dh" ? 65 : 16).fill(n).buffer,
			unsubscribe: () => {
				sub.unsubscribed = true;
				if (this.current === sub) this.current = null;
				return Promise.resolve(true);
			},
		};
		this.current = sub;
		return Promise.resolve(sub);
	}
}

type FakeBrowser = BrowserPush & { granted: NotificationPermission; answer: NotificationPermission };
type FakeServer = PushServer & { key: Uint8Array<ArrayBuffer>; registered: { endpoint: string; locale: string } | null; unregistered: number };

interface Setup {
	pm: FakePushManager;
	browser: FakeBrowser;
	server: FakeServer;
}

function setup(change: Partial<BrowserPush> = {}): Setup {
	const pm = new FakePushManager();
	const browser: FakeBrowser = {
		supported: true,
		needsInstall: false,
		granted: "default",
		answer: "granted",
		permission: (): NotificationPermission => browser.granted,
		requestPermission: (): Promise<NotificationPermission> => {
			browser.granted = browser.answer;
			return Promise.resolve(browser.granted);
		},
		pushManager: () => Promise.resolve<PushManagerLike | null>(pm),
		...change,
	};
	const server: FakeServer = {
		key: new Uint8Array(FAKE_PUSH_KEY),
		registered: null,
		unregistered: 0,
		config: () => Promise.resolve({ key: server.key, endpoint: server.registered?.endpoint ?? "" }),
		register: (sub, locale) => {
			expect(sub.p256dh).toHaveLength(65);
			expect(sub.auth).toHaveLength(16);
			server.registered = { endpoint: sub.endpoint, locale };
			return Promise.resolve();
		},
		unregister: () => {
			server.registered = null;
			server.unregistered++;
			return Promise.resolve();
		},
	};
	return { pm, browser, server };
}

describe("web push on this device", () => {
	it("asks for permission, subscribes with the server's key and registers", async () => {
		const { pm, browser, server } = setup();
		const push = webPushWith(server, browser, SELF);
		expect(await push.status()).toEqual({ kind: "ready", permission: "default", enabled: false });
		expect(await push.enable("vi")).toEqual({ kind: "ready", permission: "granted", enabled: true });
		expect(server.registered).toEqual({ endpoint: "https://fcm.googleapis.com/fcm/send/sub-1", locale: "vi" });
		expect(pushOnDevice(SELF)).toBe(true);
		expect(await push.status()).toEqual({ kind: "ready", permission: "granted", enabled: true });
		// Turning it on again keeps the subscription made with the same key.
		await push.enable("en");
		expect(pm.made).toBe(1);
		expect(server.registered?.locale).toBe("en");
	});

	it("stays off when the permission is refused, and reports the other states", async () => {
		const refused = setup();
		refused.browser.answer = "denied";
		expect(await webPushWith(refused.server, refused.browser, SELF).enable("vi")).toEqual({ kind: "ready", permission: "denied", enabled: false });
		expect(refused.pm.made).toBe(0);
		expect(pushOnDevice(SELF)).toBe(false);

		const ios = setup({ needsInstall: true, supported: false });
		expect(await webPushWith(ios.server, ios.browser, SELF).status()).toEqual({ kind: "needs-install" });
		const old = setup({ supported: false });
		expect(await webPushWith(old.server, old.browser, SELF).enable("vi")).toEqual({ kind: "unsupported" });
		const off = setup();
		off.server.key = new Uint8Array(0);
		expect(await webPushWith(off.server, off.browser, SELF).status()).toEqual({ kind: "off" });
	});

	it("turns off: flag first, then the server and the browser subscription", async () => {
		const { pm, browser, server } = setup();
		const push = webPushWith(server, browser, SELF);
		await push.enable("vi");
		const sub = pm.current;
		expect(await push.disable()).toEqual({ kind: "ready", permission: "granted", enabled: false });
		expect(pushOnDevice(SELF)).toBe(false);
		expect(server.registered).toBeNull();
		expect(sub?.unsubscribed).toBe(true);
	});

	it("syncs at start: registers again, renews a subscription of an old key, drops what should not be there", async () => {
		const { pm, browser, server } = setup();
		const push = webPushWith(server, browser, SELF);
		await push.enable("vi");
		// A new session (signed in again): the server has nothing yet.
		server.registered = null as FakeServer["registered"];
		await push.sync("vi");
		expect(server.registered?.endpoint).toBe("https://fcm.googleapis.com/fcm/send/sub-1");

		// The server's key changed: subscribe again with the new one.
		server.key = new Uint8Array(65).fill(7);
		await push.sync("en");
		expect(pm.made).toBe(2);
		expect(server.registered).toEqual({ endpoint: "https://fcm.googleapis.com/fcm/send/sub-2", locale: "en" });

		// The permission was withdrawn in the browser: everything goes.
		browser.granted = "denied";
		await push.sync("vi");
		expect(pushOnDevice(SELF)).toBe(false);
		expect(server.registered).toBeNull();
		expect(pm.current).toBeNull();
	});

	it("drops another account's leftover subscription on a device turned off for this user", async () => {
		const { pm, browser, server } = setup();
		browser.granted = "granted";
		await webPushWith(server, browser, SELF + 1).enable("vi");
		const leftover = pm.current;
		await webPushWith(server, browser, SELF).sync("vi");
		expect(leftover?.unsubscribed).toBe(true);
	});
});

describe("notifications tab: this device", () => {
	const saved = { notification: globalThis.Notification, pushManager: window.PushManager };
	let pm: FakePushManager;

	beforeEach(() => {
		pm = new FakePushManager();
		let permission: NotificationPermission = "default";
		vi.stubGlobal("Notification", {
			get permission() {
				return permission;
			},
			requestPermission: () => {
				permission = "granted";
				return Promise.resolve(permission);
			},
		});
		vi.stubGlobal("PushManager", function PushManager() {});
		Object.defineProperty(navigator, "serviceWorker", {
			configurable: true,
			value: { ready: Promise.resolve({ pushManager: pm }), getRegistration: () => Promise.resolve(undefined) },
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		Reflect.deleteProperty(navigator, "serviceWorker");
		expect(globalThis.Notification).toBe(saved.notification);
		expect(window.PushManager).toBe(saved.pushManager);
	});

	it("turns background notifications on and off for this browser", async () => {
		const demo = seedDemo();
		const f = demo.fixture;
		renderMessaging(f, "/settings/notifications");
		const toggle = await screen.findByRole("switch", { name: "Thông báo khi đã đóng app" }, LONG);
		expect(toggle.getAttribute("aria-checked")).toBe("false");
		expect(screen.getByText(/Thông báo hiện khi tab của app đang mở/)).toBeTruthy();

		await userEvent.click(toggle);
		await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"), LONG);
		expect(f.push.registration?.endpoint).toBe("https://fcm.googleapis.com/fcm/send/sub-1");
		expect(f.push.registration?.locale).toBe("vi");
		expect(pushOnDevice(f.selfId)).toBe(true);
		expect(await screen.findAllByText("Đã bật thông báo trên thiết bị này")).not.toHaveLength(0);
		expect(screen.getByText(/trừ lúc bạn đang mở app ở thiết bị khác/)).toBeTruthy();
		// The permission banner follows the answer.
		expect(screen.getByText("Trình duyệt đã cho phép thông báo.")).toBeTruthy();

		await userEvent.click(toggle);
		await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"), LONG);
		expect(f.push.registration).toBeNull();
		expect(pm.current).toBeNull();
		expect(pushOnDevice(f.selfId)).toBe(false);
	});

	it("hides the card when the server has Web Push off", async () => {
		const demo = seedDemo();
		demo.fixture.push.key = new Uint8Array(0);
		renderMessaging(demo.fixture, "/settings/notifications");
		await screen.findByRole("switch", { name: "Thông báo kênh" }, LONG);
		// Give the device card's request time to answer.
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(screen.queryByRole("switch", { name: "Thông báo khi đã đóng app" })).toBeNull();
		expect(screen.queryByText("Thiết bị này")).toBeNull();
	});

	it("tells a browser without Web Push that notifications need the open tab", async () => {
		vi.stubGlobal("PushManager", undefined);
		const demo = seedDemo();
		renderMessaging(demo.fixture, "/settings/notifications");
		expect(await screen.findByText(/Trình duyệt này không báo tin khi đã đóng tab/, {}, LONG)).toBeTruthy();
		expect(screen.queryByRole("switch", { name: "Thông báo khi đã đóng app" })).toBeNull();
	});
});

describe("background in-app notifications with push on this device", () => {
	it("are left to the push", async () => {
		const { decideNotification } = await import("../src/messaging/data/notification-filter.ts");
		const { DEFAULT_NOTIFICATION_SETTINGS } = await import("@app/core");
		const request = { title: "Lan Anh", body: "Chào", tag: "chat:7", chatId: 7 };
		const now = 1_760_500_000;
		expect(decideNotification({ ...request, background: true }, undefined, DEFAULT_NOTIFICATION_SETTINGS, now, "x", true)).toBeNull();
		expect(decideNotification({ ...request, background: false }, undefined, DEFAULT_NOTIFICATION_SETTINGS, now, "x", true)).not.toBeNull();
		expect(decideNotification({ ...request, background: true }, undefined, DEFAULT_NOTIFICATION_SETTINGS, now, "x", false)).not.toBeNull();
		setPushOnDevice(SELF, false);
	});
});

describe("Settings › Cài ứng dụng", () => {
	captureInstallPrompt();

	it("opens the browser's install dialog when it offered one", async () => {
		const prompt = vi.fn(() => Promise.resolve());
		const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
			prompt,
			userChoice: Promise.resolve({ outcome: "accepted" as const }),
		});
		window.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
		const demo = seedDemo();
		renderMessaging(demo.fixture, "/settings/app");
		const button = await screen.findByRole("button", { name: "Cài ứng dụng" }, LONG);
		const nav = screen.getByRole("navigation", { name: "Danh mục cài đặt" });
		expect(within(nav).getByRole("link", { name: "Cài ứng dụng" }).getAttribute("aria-current")).toBe("page");
		await userEvent.click(button);
		expect(prompt).toHaveBeenCalledOnce();
		expect(await screen.findAllByText("Đang cài ứng dụng")).not.toHaveLength(0);
		// The event is used once; the browser's menu remains.
		expect(await screen.findByText(/Mở menu của trình duyệt/)).toBeTruthy();
	});

	it("shows the home screen steps on iPhone and the installed state in the app", async () => {
		const agent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari");
		const demo = seedDemo();
		const view = renderMessaging(demo.fixture, "/settings/app");
		expect(await screen.findByText("Thêm vào Màn hình chính", {}, LONG)).toBeTruthy();
		expect(screen.getByText(/iOS 16.4 trở lên/)).toBeTruthy();
		view.unmount();
		agent.mockRestore();

		window.dispatchEvent(new Event("appinstalled"));
		renderMessaging(seedDemo().fixture, "/settings/app");
		expect(await screen.findByText(/đã cài trên thiết bị này/, {}, LONG)).toBeTruthy();
	});
});
