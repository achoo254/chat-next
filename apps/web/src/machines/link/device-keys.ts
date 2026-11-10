// This browser's device key for "My machines" (ADR 0013) and the machine keys
// it pinned, in IndexedDB. The private key is a non-extractable WebCrypto
// X25519 key: IndexedDB stores the CryptoKey object itself (structured
// clone), so the key material never exists as bytes the page could read or
// send anywhere. A browser that cannot keep a CryptoKey there (iOS WebKit
// reads it back as null) keeps the key as PKCS#8 bytes instead and imports it
// non-extractable on every load. Ending the session deletes the database
// (@achoo254/chat-core wipeDeviceKeys); clearing site data does too, after
// which the device pairs again with the machine's Authenticator code.
import { DEVICE_KEYS_DATABASE } from "@achoo254/chat-core";
import { exportPrivateKey, generateKeyPair, importKeyPair, type KeyPair } from "@achoo254/chat-remote-protocol";

const STORE = "keys";
const DEVICE = "device";
const VERSION = 1;

type StoredDevice = { readonly publicKey: Uint8Array<ArrayBuffer>; readonly privateKey: CryptoKey };
/** The record of a browser that cannot keep a CryptoKey in IndexedDB. */
type StoredDeviceBytes = { readonly publicKey: Uint8Array<ArrayBuffer>; readonly pkcs8: Uint8Array<ArrayBuffer> };

export interface DeviceKeyStore {
	/** The device key, made on first use. */
	device(): Promise<KeyPair>;
	/** The machine key pinned for `machine` (a machine id, or "local" in development). */
	pinned(machine: string): Promise<Uint8Array | null>;
	pin(machine: string, key: Uint8Array): Promise<void>;
	forget(machine: string): Promise<void>;
}

function promised<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
	});
}

function machineKey(machine: string): string {
	return `machine:${machine}`;
}

/** 32 bytes read back from IndexedDB (a typed array of whichever realm stored it). */
function key32(value: unknown): Uint8Array<ArrayBuffer> | null {
	if (!ArrayBuffer.isView(value) || value.byteLength !== 32) return null;
	return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + 32)) as Uint8Array<ArrayBuffer>;
}

function storedDevice(value: unknown): KeyPair | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	const publicKey = key32(v.publicKey);
	const privateKey = v.privateKey;
	if (publicKey === null || typeof privateKey !== "object" || privateKey === null) return null;
	return { publicKey, privateKey: privateKey as CryptoKey };
}

/**
 * Asks the browser not to evict this origin's storage under pressure (iOS
 * home-screen apps otherwise can lose the device key and need pairing again).
 * Best effort: a refusal or a browser without the call changes nothing.
 */
async function requestPersistentStorage(): Promise<void> {
	try {
		const storage = typeof navigator === "undefined" ? undefined : navigator.storage;
		if (storage === undefined || typeof storage.persist !== "function") return;
		if (await storage.persisted?.()) return;
		await storage.persist();
	} catch {
		// Not allowed here: keep going with best-effort storage.
	}
}

function storedDeviceBytes(value: unknown): Uint8Array<ArrayBuffer> | null {
	if (typeof value !== "object" || value === null) return null;
	const pkcs8 = (value as Record<string, unknown>).pkcs8;
	if (!ArrayBuffer.isView(pkcs8) || pkcs8.byteLength === 0) return null;
	return new Uint8Array(pkcs8.buffer.slice(pkcs8.byteOffset, pkcs8.byteOffset + pkcs8.byteLength)) as Uint8Array<ArrayBuffer>;
}

/** `factory` is the browser's indexedDB; tests pass a fake. */
export function deviceKeyStore(
	factory: IDBFactory = indexedDB,
	makeKey: (extractable: boolean) => Promise<KeyPair> = generateKeyPair,
): DeviceKeyStore {
	let db: Promise<IDBDatabase> | null = null;
	let device: Promise<KeyPair> | null = null;

	const open = (): Promise<IDBDatabase> => {
		db ??= new Promise<IDBDatabase>((resolve, reject) => {
			const request = factory.open(DEVICE_KEYS_DATABASE, VERSION);
			request.onupgradeneeded = () => request.result.createObjectStore(STORE);
			request.onsuccess = () => {
				const opened = request.result;
				// Sign-out deletes the database from the client worker: let it.
				opened.onversionchange = () => {
					opened.close();
					db = null;
					device = null;
				};
				resolve(opened);
			};
			request.onerror = () => reject(request.error ?? new Error("cannot open the device key store"));
			request.onblocked = () => reject(new Error("the device key store is blocked by another tab"));
		}).catch((err: unknown) => {
			db = null;
			throw err;
		});
		return db;
	};

	const read = async (key: string): Promise<unknown> => {
		const tx = (await open()).transaction(STORE, "readonly");
		return promised(tx.objectStore(STORE).get(key));
	};

	const write = async (key: string, value: unknown | undefined): Promise<void> => {
		const tx = (await open()).transaction(STORE, "readwrite");
		const done = new Promise<void>((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
			tx.onabort = () => reject(tx.error ?? new Error("IndexedDB write aborted"));
		});
		const store = tx.objectStore(STORE);
		await Promise.all([value === undefined ? promised(store.delete(key)) : promised(store.put(value, key)), done]);
	};

	/** First use: make the key and prove the browser keeps it, else keep it as bytes. */
	const createDevice = async (): Promise<KeyPair> => {
		const pair = await makeKey(false);
		if (pair.privateKey.extractable) throw new Error("the device key must not be extractable");
		const record: StoredDevice = { publicKey: pair.publicKey, privateKey: pair.privateKey };
		await write(DEVICE, record);
		if (storedDevice(await read(DEVICE)) !== null) return pair;
		console.warn("machines: the browser did not keep the device key object; keeping it as bytes");
		const exportable = await makeKey(true);
		const pkcs8 = await exportPrivateKey(exportable.privateKey);
		const bytes: StoredDeviceBytes = { publicKey: exportable.publicKey, pkcs8 };
		await write(DEVICE, bytes);
		if (storedDeviceBytes(await read(DEVICE)) === null) throw new Error("the browser cannot keep the device key");
		return importKeyPair(pkcs8);
	};

	const loadDevice = async (): Promise<KeyPair> => {
		await requestPersistentStorage();
		const existing = await read(DEVICE);
		const stored = storedDevice(existing);
		if (stored !== null) return stored;
		const bytes = storedDeviceBytes(existing);
		if (bytes !== null) return importKeyPair(bytes);
		// A record that is there but unreadable is not "no key yet": making a new
		// key over it would silently turn this browser into an unknown device for
		// every machine it is paired with. Fail instead, so the link retries.
		if (existing !== undefined && existing !== null) throw new Error("the stored device key is unreadable");
		console.info("machines: made a new device key (none was stored)");
		return createDevice();
	};

	return {
		device() {
			device ??= loadDevice().catch((err: unknown) => {
				device = null;
				throw err;
			});
			return device;
		},
		async pinned(machine) {
			return key32(await read(machineKey(machine)));
		},
		async pin(machine, key) {
			if (key.length !== 32) throw new Error("a machine key is 32 bytes");
			await write(machineKey(machine), new Uint8Array(key));
		},
		async forget(machine) {
			await write(machineKey(machine), undefined);
		},
	};
}
