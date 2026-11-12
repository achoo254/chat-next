// Registering this device's key with the account (MachinesService
// RegisterDevice) before any link uses it: the machines accept the device
// keys the account lists for them, so a key the account does not know opens
// nothing. The server sends a challenge; the device proves it holds the
// private key (proveKeyPossession) and names itself. Once per page: calling
// again from the same session with the same key only renames it.
//
// A key the account revoked (or another session holds) never comes back:
// the device makes a new key and registers that one, once. A session that
// already lost a device to a revocation cannot register any key: it must
// sign in again.
import { Code, ConnectError } from "@connectrpc/connect";
import { proveKeyPossession, type KeyPair } from "@achoo254/chat-remote-protocol";
import type { MachinesDirectory } from "../machines-client.ts";
import type { DeviceKeyStore } from "./device-keys.ts";

/** How this device names itself on the account's device list. */
export interface DeviceIdentity {
	readonly name: string;
	/** [a-z0-9-]{1,32}: "web", "pwa", "ios", "android". */
	readonly platform: string;
}

export type RegistrationRefusal =
	/** A device of this session was revoked: sign in again. */
	| "session-revoked"
	/** The account holds as many devices as it may: revoke one first. */
	| "too-many-devices";

/** The account will not take this device's key until the user acts. */
export class DeviceRegistrationRefused extends Error {
	constructor(readonly reason: RegistrationRefusal) {
		super(`device registration refused: ${reason}`);
	}
}

/** What the server's refusal means for this device ("" when it is none of these). */
function refusalOf(err: unknown): "renew" | RegistrationRefusal | "" {
	const e = ConnectError.from(err);
	const reason = e.rawMessage.split(":", 1)[0] ?? "";
	if (e.code === Code.PermissionDenied && reason === "device_revoked") return "renew";
	if (e.code === Code.FailedPrecondition && reason === "device_key_in_use") return "renew";
	if (e.code === Code.PermissionDenied && reason === "session_devices_revoked") return "session-revoked";
	if (e.code === Code.ResourceExhausted && reason === "too_many_devices") return "too-many-devices";
	return "";
}

type Registry = Pick<MachinesDirectory, "keyChallenge" | "registerDevice">;

async function register(registry: Registry, device: KeyPair, identity: DeviceIdentity): Promise<void> {
	const challenge = await registry.keyChallenge();
	const mac = await proveKeyPossession(device.privateKey, { serverKey: challenge.serverKey, nonce: challenge.nonce });
	await registry.registerDevice({ publicKey: device.publicKey, name: identity.name, platform: identity.platform, challenge, mac });
}

/**
 * The device key, registered with the account; the first call registers it
 * (and renews it once when the account refused it), later calls share that
 * result. A failure is not kept: the next call tries again. Rejects with
 * DeviceRegistrationRefused when only the user can unblock it.
 */
export function registeredDevice(keys: DeviceKeyStore, registry: Registry, identity: DeviceIdentity): () => Promise<KeyPair> {
	let pending: Promise<KeyPair> | null = null;
	const run = async (): Promise<KeyPair> => {
		const device = await keys.device();
		try {
			await register(registry, device, identity);
			return device;
		} catch (err) {
			const refusal = refusalOf(err);
			if (refusal === "session-revoked" || refusal === "too-many-devices") throw new DeviceRegistrationRefused(refusal);
			if (refusal !== "renew") throw err;
		}
		console.info("machines: the account refused this device key; making a new one");
		const renewed = await keys.renew();
		try {
			await register(registry, renewed, identity);
		} catch (err) {
			const refusal = refusalOf(err);
			// A second refusal of a brand-new key: this session may not add devices.
			if (refusal === "renew" || refusal === "session-revoked") throw new DeviceRegistrationRefused("session-revoked");
			if (refusal === "too-many-devices") throw new DeviceRegistrationRefused(refusal);
			throw err;
		}
		return renewed;
	};
	return () => {
		pending ??= run().catch((err: unknown) => {
			pending = null;
			throw err;
		});
		return pending;
	};
}

const BROWSERS: readonly (readonly [RegExp, string])[] = [
	[/Edg\//, "Edge"],
	[/Firefox\//, "Firefox"],
	[/Chrome\//, "Chrome"],
	[/Safari\//, "Safari"],
];

const SYSTEMS: readonly (readonly [RegExp, string])[] = [
	[/iPhone/, "iPhone"],
	[/iPad/, "iPad"],
	[/Android/, "Android"],
	[/Windows/, "Windows"],
	[/Mac OS X|Macintosh/, "macOS"],
	[/Linux/, "Linux"],
];

const firstMatch = (table: readonly (readonly [RegExp, string])[], text: string): string => table.find(([pattern]) => pattern.test(text))?.[1] ?? "";

/** A name such as "Chrome · Windows" for a browser. */
export function browserName(userAgent: string): string {
	const browser = firstMatch(BROWSERS, userAgent) || "Browser";
	const os = firstMatch(SYSTEMS, userAgent);
	return os === "" ? browser : `${browser} · ${os}`;
}

/**
 * This device on the account's list: the app ("App <name> · iOS" / Android)
 * in the native build, else the browser and its system; "pwa" when the web
 * app runs installed.
 */
export function deviceIdentity(opts: { userAgent: string; native: boolean; standalone: boolean; appName: string }): DeviceIdentity {
	if (opts.native) {
		const android = /Android/.test(opts.userAgent);
		return { name: `App ${opts.appName} · ${android ? "Android" : "iOS"}`, platform: android ? "android" : "ios" };
	}
	return { name: browserName(opts.userAgent), platform: opts.standalone ? "pwa" : "web" };
}
