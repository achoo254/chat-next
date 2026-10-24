// The web client reaches the chat server at apiOrigin: the page's own origin
// on the web (cookie session), any http(s) origin with a native connection.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkApiOrigin, createWebChat, type WorkerLike } from "../src/client.ts";
import type { ToWorker } from "../src/protocol.ts";

const PAGE = "https://chat.example.test";

describe("checkApiOrigin", () => {
	it("accepts the page's origin and normalises it", () => {
		expect(checkApiOrigin(PAGE, PAGE, false)).toBe(PAGE);
		expect(checkApiOrigin(`${PAGE}/`, PAGE, false)).toBe(PAGE);
		expect(checkApiOrigin("http://localhost:5173", "http://localhost:5173", false)).toBe("http://localhost:5173");
	});

	it("refuses a path, query or credentials, which the server's root routes would lose", () => {
		for (const bad of [`${PAGE}/api`, `${PAGE}/?a=1`, `${PAGE}/#x`, "https://user:pw@chat.example.test"]) {
			expect(() => checkApiOrigin(bad, PAGE, true)).toThrow(/origin only/);
		}
	});

	it("refuses another origin on the web, naming the reverse proxy fix", () => {
		expect(() => checkApiOrigin("https://api.example.test", PAGE, false)).toThrow(
			/is not this page's origin https:\/\/chat\.example\.test.*proxy \/rpc, \/auth and \/ws/,
		);
	});

	it("lets a native connection reach another origin", () => {
		expect(checkApiOrigin("https://chat.example.test", "capacitor://localhost", true)).toBe(PAGE);
	});

	it("refuses what is not an http(s) origin", () => {
		expect(() => checkApiOrigin("", PAGE, false)).toThrow(TypeError);
		expect(() => checkApiOrigin("chat.example.test", PAGE, false)).toThrow(TypeError);
		expect(() => checkApiOrigin("ftp://chat.example.test", PAGE, true)).toThrow(/http\(s\) origin/);
	});
});

class RecordingWorker implements WorkerLike {
	readonly posted: ToWorker[] = [];

	postMessage(message: ToWorker): void {
		this.posted.push(message);
	}

	addEventListener(): void {}

	terminate(): void {}
}

function memoryStorage(): Storage {
	const items = new Map<string, string>();
	return {
		get length() {
			return items.size;
		},
		clear: () => items.clear(),
		getItem: (key) => items.get(key) ?? null,
		key: (index) => [...items.keys()][index] ?? null,
		removeItem: (key) => void items.delete(key),
		setItem: (key, value) => void items.set(key, value),
	};
}

describe("createWebChat apiOrigin", () => {
	const disposers: (() => void)[] = [];

	beforeEach(() => {
		const listeners = { addEventListener: () => undefined, removeEventListener: () => undefined };
		vi.stubGlobal("document", { ...listeners, hidden: false });
		vi.stubGlobal("window", listeners);
		vi.stubGlobal("location", { origin: PAGE });
	});

	afterEach(() => {
		for (const dispose of disposers.splice(0)) dispose();
		vi.unstubAllGlobals();
	});

	it("hands the normalised origin to the worker", () => {
		const worker = new RecordingWorker();
		const chat = createWebChat({ createWorker: () => worker, apiOrigin: `${PAGE}/`, appVersion: "test", storage: memoryStorage() });
		disposers.push(() => chat.dispose());
		const init = worker.posted.find((message) => message.type === "init");
		expect(init?.type === "init" ? init.config.apiOrigin : undefined).toBe(PAGE);
	});

	it("fails before starting a worker when the web client names another origin", () => {
		const createWorker = vi.fn(() => new RecordingWorker());
		expect(() => createWebChat({ createWorker, apiOrigin: "https://api.example.test", appVersion: "test", storage: memoryStorage() })).toThrow(
			/not this page's origin/,
		);
		expect(createWorker).not.toHaveBeenCalled();
	});
});
