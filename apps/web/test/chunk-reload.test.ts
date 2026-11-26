import { describe, expect, it, vi } from "vitest";
import { RELOAD_GUARD_MS, isChunkLoadError, recoverFromError, reloadForNewBuild, showReloadNotice } from "../src/chunk-reload.ts";

function memoryStorage(initial: Record<string, string> = {}): Storage {
	const data = new Map(Object.entries(initial));
	return {
		get length() {
			return data.size;
		},
		clear: () => data.clear(),
		getItem: (key) => data.get(key) ?? null,
		key: (index) => [...data.keys()][index] ?? null,
		removeItem: (key) => void data.delete(key),
		setItem: (key, value) => void data.set(key, value),
	};
}

describe("chunk load errors", () => {
	it("recognises what each browser says about a failed dynamic import", () => {
		expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: https://x/assets/ai-panel-session-abc.js"))).toBe(true);
		expect(isChunkLoadError(new TypeError("error loading dynamically imported module: https://x/assets/a.js"))).toBe(true);
		expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
		expect(isChunkLoadError(new Error("Unable to preload CSS for /assets/a.css"))).toBe(true);
		expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'name')"))).toBe(false);
		expect(isChunkLoadError("network down")).toBe(false);
	});
});

describe("reloading for the current build", () => {
	it("reloads once, then not again within the guard", () => {
		const storage = memoryStorage();
		const reload = vi.fn();
		expect(reloadForNewBuild(1_000_000, storage, reload)).toBe(true);
		expect(reload).toHaveBeenCalledTimes(1);
		expect(reloadForNewBuild(1_000_000 + RELOAD_GUARD_MS - 1, storage, reload)).toBe(false);
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it("reloads again once the guard has passed", () => {
		const storage = memoryStorage({ "chunk-reload-at": "1000" });
		const reload = vi.fn();
		expect(reloadForNewBuild(1000 + RELOAD_GUARD_MS, storage, reload)).toBe(true);
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it("never reloads by itself when it cannot remember the reload", () => {
		const reload = vi.fn();
		const blocked = memoryStorage();
		blocked.setItem = () => {
			throw new Error("blocked");
		};
		expect(reloadForNewBuild(5, blocked, reload)).toBe(false);
		expect(reloadForNewBuild(5, undefined, reload)).toBe(false);
		expect(reload).not.toHaveBeenCalled();
	});
});

describe("the notice on the splash", () => {
	it("replaces the loading text with a message and a reload button in the page language", () => {
		document.documentElement.lang = "vi";
		document.body.innerHTML = '<div id="splash" class="brand-loader page" aria-busy="true" hidden><p class="brand-loader-text">Đang tải…</p></div>';
		showReloadNotice("chunk");
		const splash = document.getElementById("splash");
		expect(splash?.hidden).toBe(false);
		expect(splash?.getAttribute("aria-busy")).toBe("false");
		expect(splash?.querySelector(".brand-loader-text")?.textContent).toBe("Không tải được phần mới của ứng dụng.");
		expect(splash?.querySelector("button")?.textContent).toBe("Tải lại");
		showReloadNotice("chunk");
		expect(splash?.querySelectorAll("button")).toHaveLength(1);
	});

	it("speaks English on an English page", () => {
		document.documentElement.lang = "en";
		document.body.innerHTML = '<div id="splash"><p class="brand-loader-text"></p></div>';
		showReloadNotice("chunk");
		expect(document.querySelector("#splash button")?.textContent).toBe("Reload");
	});

	it("says the app stopped after any other error that unmounted it", () => {
		document.documentElement.lang = "vi";
		document.body.innerHTML = '<div id="splash" hidden><p class="brand-loader-text">Đang tải…</p></div>';
		showReloadNotice("crash");
		expect(document.querySelector("#splash .brand-loader-text")?.textContent).toBe("Ứng dụng gặp lỗi và đã dừng.");
		expect(document.querySelector("#splash button")?.textContent).toBe("Tải lại");
		document.documentElement.lang = "zh-CN";
		document.body.innerHTML = '<div id="splash"><p class="brand-loader-text"></p></div>';
		showReloadNotice("crash");
		expect(document.querySelector("#splash .brand-loader-text")?.textContent).toBe("应用出错，已停止运行。");
	});
});

describe("an error that reached the top", () => {
	it("shows the crash notice only when the error unmounted the app", () => {
		document.documentElement.lang = "vi";
		document.body.innerHTML = '<div id="splash" hidden><p class="brand-loader-text">Đang tải…</p></div>';
		expect(recoverFromError(new TypeError("x is undefined"), false)).toBe(false);
		expect(document.getElementById("splash")?.hidden).toBe(true);
		expect(recoverFromError(new TypeError("x is undefined"), true)).toBe(true);
		expect(document.querySelector("#splash .brand-loader-text")?.textContent).toBe("Ứng dụng gặp lỗi và đã dừng.");
	});
});

