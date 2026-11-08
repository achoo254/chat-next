// This browser's device key for "My machines" (ADR 0013) and the machine keys
// it pinned, in IndexedDB. The private key is a non-extractable WebCrypto
// X25519 key: IndexedDB stores the CryptoKey object itself (structured
// clone), so the key material never exists as bytes the page could read or
// send anywhere. Ending the session deletes the database
// (@achoo254/chat-core wipeDeviceKeys); clearing site data does too, after
// which the device pairs again with `hda pair`.
import { DEVICE_KEYS_DATABASE } from "@achoo254/chat-core";
import { generateKeyPair, type KeyPair } from "@achoo254/chat-remote-protocol";

const STORE = "keys";
const DEVICE = "device";
const VERSION = 1;

type StoredDevice = { readonly publicKey: Uint8Array<ArrayBuffer>; readonly privateKey: CryptoKey };

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

/** `factory` is the browser's indexedDB; tests pass a fake. */
export function deviceKeyStore(factory: IDBFactory = indexedDB, makeKey: () => Promise<KeyPair> = () => generateKeyPair(false)): DeviceKeyStore {
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

	const loadDevice = async (): Promise<KeyPair> => {
		const stored = storedDevice(await read(DEVICE));
		if (stored !== null) return stored;
		const pair = await makeKey();
		if (pair.privateKey.extractable) throw new Error("the device key must not be extractable");
		const record: StoredDevice = { publicKey: pair.publicKey, privateKey: pair.privateKey };
		await write(DEVICE, record);
		return pair;
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
