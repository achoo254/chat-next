// The device key store on a small fake IndexedDB: one non-extractable key
// made once and kept (and renewed on demand), the machine keys seen last
// remembered and forgotten, and the connection
// closing when sign-out deletes the database.
import { DEVICE_KEYS_DATABASE } from "@achoo254/chat-core";
import { generateKeyPair } from "@achoo254/chat-remote-protocol";
import { describe, expect, it, vi } from "vitest";
import { deviceKeyStore } from "../../src/machines/link/device-keys.ts";

type Handler = (() => void) | null;

class FakeRequest<T> {
	result = undefined as T;
	error: Error | null = null;
	onsuccess: Handler = null;
	onerror: Handler = null;
	onupgradeneeded: Handler = null;
	onblocked: Handler = null;
}

/** Just enough of IndexedDB for device-keys.ts: one database of key-value stores. */
class FakeIndexedDb {
	/** WebKit on iOS: a CryptoKey put in a record reads back as null. */
	constructor(readonly dropCryptoKeys = false) {}
	readonly databases = new Map<string, Map<string, Map<string, unknown>>>();
	readonly open_: FakeDb[] = [];

	open(name: string): FakeRequest<FakeDb> {
		const request = new FakeRequest<FakeDb>();
		setTimeout(() => {
			let stores = this.databases.get(name);
			const fresh = stores === undefined;
			stores ??= new Map();
			this.databases.set(name, stores);
			const db = new FakeDb(stores, this.dropCryptoKeys);
			this.open_.push(db);
			request.result = db;
			if (fresh) request.onupgradeneeded?.();
			request.onsuccess?.();
		}, 0);
		return request;
	}

	/** What a deletion from another context does to open connections. */
	deleteDatabase(name: string): void {
		for (const db of this.open_) db.onversionchange?.();
		this.databases.delete(name);
	}
}

class FakeDb {
	onversionchange: Handler = null;
	closed = false;
	constructor(
		private readonly stores: Map<string, Map<string, unknown>>,
		private readonly dropCryptoKeys: boolean,
	) {}
	createObjectStore(name: string): void {
		this.stores.set(name, new Map());
	}
	close(): void {
		this.closed = true;
	}
	transaction(name: string) {
		const store = this.stores.get(name);
		if (store === undefined) throw new Error(`no store ${name}`);
		const tx = { oncomplete: null as Handler, onerror: null as Handler, onabort: null as Handler, error: null, objectStore: () => api };
		const settle = <T,>(value: T): FakeRequest<T> => {
			const request = new FakeRequest<T>();
			request.result = value;
			setTimeout(() => {
				request.onsuccess?.();
				setTimeout(() => tx.oncomplete?.(), 0);
			}, 0);
			return request;
		};
		const api = {
			get: (key: string) => settle(structuredClone(store.get(key))),
			put: (value: unknown, key: string) => {
				const holdsCryptoKey = typeof value === "object" && value !== null && (value as { privateKey?: unknown }).privateKey instanceof CryptoKey;
				store.set(key, this.dropCryptoKeys && holdsCryptoKey ? null : value);
				return settle(key);
			},
			delete: (key: string) => {
				store.delete(key);
				return settle(undefined);
			},
		};
		return tx;
	}
}

const asFactory = (fake: FakeIndexedDb) => fake as unknown as IDBFactory;

describe("device key store", () => {
	it("makes one non-extractable device key and keeps it", async () => {
		const idb = new FakeIndexedDb();
		const make = vi.fn(() => generateKeyPair(false));
		const first = deviceKeyStore(asFactory(idb), make);
		const key = await first.device();
		expect(key.publicKey).toHaveLength(32);
		expect(key.privateKey.extractable).toBe(false);
		expect(await first.device()).toBe(key);
		// A new page (new store object) reads the same key back.
		const again = await deviceKeyStore(asFactory(idb), make).device();
		expect(again.publicKey).toEqual(key.publicKey);
		expect(make).toHaveBeenCalledTimes(1);
		expect(idb.databases.has(DEVICE_KEYS_DATABASE)).toBe(true);
	});

	it("refuses to keep an extractable key", async () => {
		const store = deviceKeyStore(asFactory(new FakeIndexedDb()), () => generateKeyPair(true));
		await expect(store.device()).rejects.toThrow(/extractable/);
	});

	it("remembers and forgets the key each machine answered with", async () => {
		const store = deviceKeyStore(asFactory(new FakeIndexedDb()));
		expect(await store.seenMachineKey("12")).toBeNull();
		const key = new Uint8Array(32).fill(7);
		await store.rememberMachineKey("12", key);
		expect(await store.seenMachineKey("12")).toEqual(key);
		expect(await store.seenMachineKey("13")).toBeNull();
		await store.forgetMachineKey("12");
		expect(await store.seenMachineKey("12")).toBeNull();
		await expect(store.rememberMachineKey("12", new Uint8Array(31))).rejects.toThrow();
	});

	it("renews the device key: a new one, kept for the next page", async () => {
		const idb = new FakeIndexedDb();
		const store = deviceKeyStore(asFactory(idb));
		const old = await store.device();
		const renewed = await store.renew();
		expect(renewed.publicKey).not.toEqual(old.publicKey);
		expect(renewed.privateKey.extractable).toBe(false);
		expect(await store.device()).toBe(renewed);
		expect((await deviceKeyStore(asFactory(idb)).device()).publicKey).toEqual(renewed.publicKey);
	});

	it("does not replace a stored device key it cannot read", async () => {
		const idb = new FakeIndexedDb();
		const make = vi.fn(() => generateKeyPair(false));
		await deviceKeyStore(asFactory(idb), make).device();
		const stores = idb.databases.get(DEVICE_KEYS_DATABASE);
		const keys = stores?.get("keys");
		keys?.set("device", { publicKey: new Uint8Array(3), privateKey: null });
		await expect(deviceKeyStore(asFactory(idb), make).device()).rejects.toThrow(/unreadable/);
		expect(make).toHaveBeenCalledTimes(1);
		expect(keys?.get("device")).toEqual({ publicKey: new Uint8Array(3), privateKey: null });
	});

	it("asks the browser to keep the storage before making a key", async () => {
		const persist = vi.fn(() => Promise.resolve(true));
		vi.stubGlobal("navigator", { storage: { persisted: () => Promise.resolve(false), persist } });
		try {
			await deviceKeyStore(asFactory(new FakeIndexedDb())).device();
			expect(persist).toHaveBeenCalledTimes(1);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("keeps the key as bytes when the browser reads a CryptoKey back as null", async () => {
		const idb = new FakeIndexedDb(true);
		const make = vi.fn((extractable: boolean) => generateKeyPair(extractable));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const first = await deviceKeyStore(asFactory(idb), make).device();
			expect(first.privateKey.extractable).toBe(false);
			// The next page load (a new store object) gets the same identity.
			const again = await deviceKeyStore(asFactory(idb), make).device();
			expect(again.publicKey).toEqual(first.publicKey);
			expect(again.privateKey.extractable).toBe(false);
			expect(make).toHaveBeenCalledTimes(2);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});

	it("lets sign-out delete the database and starts over after it", async () => {
		const idb = new FakeIndexedDb();
		const store = deviceKeyStore(asFactory(idb));
		const before = await store.device();
		idb.deleteDatabase(DEVICE_KEYS_DATABASE);
		expect(idb.open_[0]?.closed).toBe(true);
		const after = await store.device();
		expect(after.publicKey).not.toEqual(before.publicKey);
	});
});
