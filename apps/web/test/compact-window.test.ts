// The compact window's browser work: support detection, the copied styles and
// root attributes, the saved size, and how the store follows the window.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compactWindow, DEFAULT_SIZE, isPictureInPictureSupported, readSavedSize } from "../src/compact/compact-window-store.ts";
import { copyDocumentStyles, mirrorRootAttributes } from "../src/compact/pip-window.ts";

interface FakePip {
	readonly window: Window;
	readonly closed: () => void;
	readonly resized: (width: number, height: number) => void;
}

/** A picture-in-picture window with its own document, as `requestWindow` resolves. */
function fakePip(inner: { width: number; height: number } = { width: 0, height: 0 }): FakePip {
	const pipDocument = document.implementation.createHTMLDocument("pip");
	const listeners = new Map<string, () => void>();
	const target = {
		document: pipDocument,
		innerWidth: inner.width,
		innerHeight: inner.height,
		focus: vi.fn(),
		close: () => listeners.get("pagehide")?.(),
		addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
	};
	return {
		window: target as unknown as Window,
		closed: () => listeners.get("pagehide")?.(),
		resized: (width, height) => {
			target.innerWidth = width;
			target.innerHeight = height;
			listeners.get("resize")?.();
		},
	};
}

function installPictureInPicture(pip: FakePip): ReturnType<typeof vi.fn> {
	const requestWindow = vi.fn(async () => pip.window);
	Object.defineProperty(window, "documentPictureInPicture", { value: { requestWindow }, configurable: true });
	return requestWindow;
}

afterEach(() => {
	compactWindow.close();
	Reflect.deleteProperty(window, "documentPictureInPicture");
	vi.unstubAllGlobals();
	window.localStorage.clear();
	document.head.innerHTML = "";
	document.documentElement.removeAttribute("data-theme");
	document.documentElement.lang = "";
	document.body.className = "";
});

describe("support", () => {
	it("is off when the browser has no Document Picture-in-Picture", () => {
		expect(isPictureInPictureSupported()).toBe(false);
	});

	it("is on when the browser has it", () => {
		installPictureInPicture(fakePip());
		expect(isPictureInPictureSupported()).toBe(true);
	});

	it("opens nothing when the browser has no such window", async () => {
		await compactWindow.open();
		expect(compactWindow.get()).toBeNull();
	});
});

describe("copyDocumentStyles", () => {
	it("copies stylesheet links and style elements, not other head content", () => {
		document.head.innerHTML = '<link rel="stylesheet" href="/assets/app.css"><style>.a{color:red}</style><link rel="icon" href="/icon.svg"><title>Chat</title>';
		const target = document.implementation.createHTMLDocument("pip");
		copyDocumentStyles(document, target);
		expect(target.head.querySelector('link[rel="stylesheet"]')?.getAttribute("href")).toBe("/assets/app.css");
		expect(target.head.querySelector("style")?.textContent).toBe(".a{color:red}");
		expect(target.head.querySelector('link[rel="icon"]')).toBeNull();
	});
});

describe("mirrorRootAttributes", () => {
	it("copies the language, theme and style now and follows later changes until stopped", async () => {
		document.documentElement.lang = "vi";
		document.documentElement.setAttribute("data-theme", "dark");
		const target = document.implementation.createHTMLDocument("pip");
		const stop = mirrorRootAttributes(document.documentElement, target.documentElement);
		expect(target.documentElement.lang).toBe("vi");
		expect(target.documentElement.getAttribute("data-theme")).toBe("dark");

		document.documentElement.setAttribute("data-theme", "light");
		await Promise.resolve();
		expect(target.documentElement.getAttribute("data-theme")).toBe("light");

		stop();
		document.documentElement.setAttribute("data-theme", "dark");
		await Promise.resolve();
		expect(target.documentElement.getAttribute("data-theme")).toBe("light");
	});
});

describe("saved size", () => {
	beforeEach(() => window.localStorage.clear());

	it("is the default when nothing is saved", () => {
		expect(readSavedSize()).toEqual(DEFAULT_SIZE);
	});

	it("is the default when what is saved is not a usable size", () => {
		for (const bad of ["not json", "null", '{"width":"380","height":560}', '{"width":100,"height":560}']) {
			window.localStorage.setItem("compact-window-size", bad);
			expect(readSavedSize()).toEqual(DEFAULT_SIZE);
		}
	});

	it("is the default when storage throws", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		expect(readSavedSize()).toEqual(DEFAULT_SIZE);
		vi.restoreAllMocks();
	});
});

describe("the store", () => {
	it("opens the window at the saved size, copies the styles and the body classes, and tells subscribers", async () => {
		document.head.innerHTML = '<link rel="stylesheet" href="/assets/app.css">';
		document.body.className = "desktop";
		window.localStorage.setItem("compact-window-size", JSON.stringify({ width: 420, height: 600 }));
		const pip = fakePip();
		const requestWindow = installPictureInPicture(pip);
		const changed = vi.fn();
		const stop = compactWindow.subscribe(changed);

		await compactWindow.open();

		expect(requestWindow).toHaveBeenCalledWith({ width: 420, height: 600 });
		expect(compactWindow.get()).toBe(pip.window);
		expect(pip.window.document.head.querySelector("link")?.getAttribute("href")).toBe("/assets/app.css");
		expect(pip.window.document.body.className).toBe("desktop");
		expect(changed).toHaveBeenCalledTimes(1);
		stop();
	});

	it("focuses the open window instead of opening a second one", async () => {
		const pip = fakePip();
		const requestWindow = installPictureInPicture(pip);
		await compactWindow.open();
		await compactWindow.open();
		expect(requestWindow).toHaveBeenCalledTimes(1);
		expect(pip.window.focus).toHaveBeenCalledTimes(1);
	});

	it("opens one window when asked twice before the first resolves", async () => {
		const pip = fakePip();
		const requestWindow = installPictureInPicture(pip);
		await Promise.all([compactWindow.open(), compactWindow.open()]);
		expect(requestWindow).toHaveBeenCalledTimes(1);
	});

	it("forgets the window when it closes and can open a new one", async () => {
		const first = fakePip();
		installPictureInPicture(first);
		await compactWindow.open();
		first.closed();
		expect(compactWindow.get()).toBeNull();

		const second = fakePip();
		installPictureInPicture(second);
		await compactWindow.open();
		expect(compactWindow.get()).toBe(second.window);
	});

	it("remembers the size the window was resized to", async () => {
		const pip = fakePip();
		installPictureInPicture(pip);
		await compactWindow.open();
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.advanceTimersByTime(5000);
		pip.resized(500, 640);
		vi.useRealTimers();
		expect(readSavedSize()).toEqual({ width: 500, height: 640 });
	});

	it("does not shrink the window at each opening when the browser takes a frame off the size", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			// Chromium gives the window 45 px less height than asked (its title bar), after the open resolves.
			const first = fakePip({ width: 380, height: DEFAULT_SIZE.height });
			const firstRequest = installPictureInPicture(first);
			await compactWindow.open();
			expect(firstRequest).toHaveBeenCalledWith(DEFAULT_SIZE);
			first.resized(380, DEFAULT_SIZE.height - 45);
			// That fit is the browser's, not the user's: nothing is saved.
			expect(readSavedSize()).toEqual(DEFAULT_SIZE);

			// Later the user resizes it: the next window is asked for that inner size plus the frame.
			vi.advanceTimersByTime(5000);
			first.resized(500, 595);
			expect(readSavedSize()).toEqual({ width: 500, height: 640 });
			first.closed();

			const second = fakePip({ width: 500, height: 640 });
			const secondRequest = installPictureInPicture(second);
			await compactWindow.open();
			expect(secondRequest).toHaveBeenCalledWith({ width: 500, height: 640 });
		} finally {
			vi.useRealTimers();
		}
	});

	it("opens at the default size when storage is blocked", async () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		const pip = fakePip();
		const requestWindow = installPictureInPicture(pip);
		await compactWindow.open();
		expect(requestWindow).toHaveBeenCalledWith(DEFAULT_SIZE);
		vi.restoreAllMocks();
	});
});
