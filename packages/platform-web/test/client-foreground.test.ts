// The worker is told the app is in the foreground while the page is visible,
// or while another surface that shows the app (the compact window) says so.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebChat, type AlsoForeground, type WebChatOptions, type WorkerLike } from "../src/client.ts";

class RecordingWorker implements WorkerLike {
	readonly posted: { type: string; foreground?: boolean; config?: { foreground: boolean } }[] = [];

	postMessage(message: { type: string; foreground?: boolean; config?: { foreground: boolean } }): void {
		this.posted.push(message);
	}

	addEventListener(): void {}

	terminate(): void {}

	/** The foreground values posted after init, in order. */
	foregrounds(): boolean[] {
		return this.posted.filter((m) => m.type === "foreground").map((m) => m.foreground === true);
	}

	initialForeground(): boolean | undefined {
		return this.posted.find((m) => m.type === "init")?.config?.foreground;
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

/** A surface other than the page that can be switched on and off. */
function fakeSurface(): AlsoForeground & { set(value: boolean): void } {
	let value = false;
	const listeners = new Set<() => void>();
	return {
		get: () => value,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		set(next) {
			value = next;
			for (const listener of [...listeners]) listener();
		},
	};
}

const page = { hidden: false, handlers: new Map<string, () => void>() };

function setPageHidden(hidden: boolean): void {
	page.hidden = hidden;
	page.handlers.get("visibilitychange")?.();
}

const cleanup: (() => void)[] = [];

function start(options: Partial<WebChatOptions> = {}): RecordingWorker {
	const worker = new RecordingWorker();
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

beforeEach(() => {
	page.hidden = false;
	page.handlers.clear();
	vi.stubGlobal("document", {
		get hidden() {
			return page.hidden;
		},
		addEventListener: (type: string, handler: () => void) => page.handlers.set(type, handler),
		removeEventListener: (type: string) => page.handlers.delete(type),
	});
	vi.stubGlobal("window", { addEventListener: () => undefined, removeEventListener: () => undefined, focus: () => undefined });
	vi.stubGlobal("location", { origin: "https://chat.example.test" });
});

afterEach(() => {
	for (const run of cleanup.splice(0)) run();
	vi.unstubAllGlobals();
});

describe("createWebChat foreground", () => {
	it("follows the page's visibility when there is no other surface", () => {
		const worker = start();
		expect(worker.initialForeground()).toBe(true);
		setPageHidden(true);
		setPageHidden(false);
		expect(worker.foregrounds()).toEqual([false, true]);
	});

	it("stays in the foreground while the page is hidden and the other surface is shown", () => {
		const surface = fakeSurface();
		const worker = start({ alsoForeground: surface });
		surface.set(true);
		setPageHidden(true);
		expect(worker.foregrounds()).toEqual([true, true]);
	});

	it("goes to the background once the page is hidden and the other surface closes", () => {
		const surface = fakeSurface();
		const worker = start({ alsoForeground: surface });
		surface.set(true);
		setPageHidden(true);
		surface.set(false);
		expect(worker.foregrounds().at(-1)).toBe(false);
	});

	it("starts in the foreground when the page is hidden but the other surface is already shown", () => {
		const surface = fakeSurface();
		surface.set(true);
		page.hidden = true;
		expect(start({ alsoForeground: surface }).initialForeground()).toBe(true);
	});

	it("stops listening to the other surface when disposed", () => {
		const surface = fakeSurface();
		const subscribe = vi.spyOn(surface, "subscribe");
		const worker = start({ alsoForeground: surface });
		for (const run of cleanup.splice(0)) run();
		const before = worker.foregrounds().length;
		surface.set(true);
		expect(subscribe).toHaveBeenCalledTimes(1);
		expect(worker.foregrounds().length).toBe(before);
	});
});
