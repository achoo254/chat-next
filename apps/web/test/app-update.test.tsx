// A tab learns that a newer build took over its service worker and shows
// "Đã có bản mới · Tải lại" (register-service-worker.ts, update-bar.tsx).
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILD_QUERY, BUILD_REPLY, type MessageTarget } from "../src/sw/build-messages.ts";
import { OPEN_CHAT } from "../src/sw/push-messages.ts";

type Module = typeof import("../src/register-service-worker.ts");

/** A worker that answers build questions with its entry (null: never answers). */
function worker(entry: string | null): MessageTarget {
	return {
		postMessage: (message, transfer) => {
			const port = transfer[0] as MessagePort | undefined;
			if (entry === null || port === undefined) return;
			expect(message).toEqual({ type: BUILD_QUERY });
			port.postMessage({ type: BUILD_REPLY, entry });
			port.close();
		},
	};
}

class FakeContainer {
	controller: MessageTarget | null;
	readonly listeners = new Map<string, (event: MessageEvent) => void>();
	started = false;

	constructor(controller: MessageTarget | null) {
		this.controller = controller;
	}
	addEventListener(type: string, listener: (event: MessageEvent) => void): void {
		this.listeners.set(type, listener);
	}
	startMessages(): void {
		this.started = true;
	}
	/** A new worker takes over this tab. */
	takeOver(next: MessageTarget): void {
		this.controller = next;
		this.listeners.get("controllerchange")?.(new MessageEvent("controllerchange"));
	}
}

const MINE = "/assets/index-MINE.js";
let mod: Module;

beforeEach(async () => {
	// Each test starts with no update seen (module state).
	vi.resetModules();
	mod = await import("../src/register-service-worker.ts");
});

afterEach(() => {
	document.head.innerHTML = "";
});

/** Waits for the worker's answer (a MessageChannel round trip). */
async function settle(): Promise<void> {
	await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
}

describe("following app updates", () => {
	it("marks an update when a worker of another build replaces this tab's worker", async () => {
		const container = new FakeContainer(worker(MINE));
		mod.watchAppUpdates(container, MINE, 20);
		expect(container.started).toBe(true);
		container.takeOver(worker("/assets/index-NEWER.js"));
		await settle();
		expect(mod.appUpdateReady()).toBe(true);
	});

	it("does not when the new worker runs this tab's build, or does not answer", async () => {
		const container = new FakeContainer(worker("/assets/index-OLDER.js"));
		mod.watchAppUpdates(container, MINE, 20);
		// The tab came from the network after a deploy; the new worker catches up.
		container.takeOver(worker(MINE));
		await settle();
		// An older build's worker or the kill switch: no answer.
		container.takeOver(worker(null));
		await settle();
		expect(mod.appUpdateReady()).toBe(false);
	});

	it("does not when the first worker takes over a tab nobody controlled", async () => {
		const container = new FakeContainer(null);
		mod.watchAppUpdates(container, MINE, 20);
		container.takeOver(worker("/assets/index-NEWER.js"));
		await settle();
		expect(mod.appUpdateReady()).toBe(false);
	});

	it("answers the worker's build question with this tab's entry", () => {
		const container = new FakeContainer(null);
		mod.watchAppUpdates(container, MINE, 20);
		const port = { postMessage: vi.fn() };
		container.listeners.get("message")?.(new MessageEvent("message", { data: { type: BUILD_QUERY }, ports: [port as unknown as MessagePort] }));
		expect(port.postMessage).toHaveBeenCalledWith({ type: BUILD_REPLY, entry: MINE });
	});

	it("opens the chat of a push notification the worker focused this tab for", () => {
		const container = new FakeContainer(worker(MINE));
		mod.watchAppUpdates(container, MINE, 20);
		window.history.replaceState(null, "", "/settings/profile");
		container.listeners.get("message")?.(new MessageEvent("message", { data: { type: OPEN_CHAT, chatId: 12 } }));
		expect(window.location.pathname).toBe("/c/12");
		container.listeners.get("message")?.(new MessageEvent("message", { data: { type: OPEN_CHAT, chatId: "12" } }));
		expect(window.location.pathname).toBe("/c/12");
	});

	it("finds this tab's entry script in the page", () => {
		document.head.innerHTML = '<link rel="modulepreload" href="/assets/dep.js"><script type="module" crossorigin src="/assets/index-MINE.js"></script>';
		expect(mod.pageEntry(document)).toBe(MINE);
		document.head.innerHTML = "";
		expect(mod.pageEntry(document)).toBeNull();
	});
});

describe("update bar", () => {
	it("appears once an update is seen, and reloads only when asked", async () => {
		const { UpdateBar } = await import("../src/components/update-bar.tsx");
		const { I18nProvider } = await import("../src/i18n/i18n.tsx");
		const reload = vi.fn();
		vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, reload });
		render(
			<I18nProvider>
				<UpdateBar />
			</I18nProvider>,
		);
		expect(screen.queryByRole("status")).toBeNull();

		const container = new FakeContainer(worker(MINE));
		mod.watchAppUpdates(container, MINE, 20);
		container.takeOver(worker("/assets/index-NEWER.js"));
		await settle();
		expect(screen.getByRole("status").textContent).toBe("Đã có bản mới·Tải lại");
		expect(reload).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: "Tải lại" }));
		expect(reload).toHaveBeenCalledOnce();
		vi.restoreAllMocks();
	});
});
