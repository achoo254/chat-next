// The devices paired with a machine, as the machine lists them (MachineInfo),
// on the machine's page: name, pairing date, "this device", and revoking any
// of them through the directory (MachinesService.RevokeDevice). Revoking
// this device also forgets the machine's key here, so it must pair again.
import type { PairedDevice } from "@achoo254/chat-proto/remote/remote";
import { useI18n } from "../i18n/i18n.tsx";
import type { LinkHub } from "./link/link-hub.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

export function sameKey(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** Hex of a device key, for React keys and the revoked set. */
export function keyText(key: Uint8Array): string {
	return Array.from(key, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Revokes `device` (null: this device, when the machine's list is not known)
 * on machine `machineId`; for this device the machine's key is forgotten too.
 * Resolves with whose device it was.
 */
export async function revokePairedDevice(
	hub: Pick<LinkHub, "deps" | "forget">,
	ref: string,
	machineId: number,
	device: PairedDevice | null,
): Promise<"self" | "other"> {
	const mine = (await hub.deps.keys.device()).publicKey;
	const key = device?.publicKey ?? mine;
	const self = sameKey(key, mine);
	await hub.deps.directory.revokeDevice(machineId, key);
	if (self) await hub.forget(ref);
	return self ? "self" : "other";
}

interface PairedDevicesProps {
	devices: readonly PairedDevice[];
	/** This browser's device key; null until read. */
	myKey: Uint8Array | null;
	/** Keys (keyText) revoked from this page, waiting for the machine to drop them. */
	revoked: ReadonlySet<string>;
	/** Revoking goes through the directory: not for the development machine. */
	canRevoke: boolean;
	/** This device's name, shown alone while the machine's list is not known. */
	deviceName: string;
	onRevoke: (device: PairedDevice | null) => void;
}

export function PairedDevices({ devices, myKey, revoked, canRevoke, deviceName, onRevoke }: PairedDevicesProps) {
	const t = useMachinesCopy();
	const { locale } = useI18n();
	if (devices.length === 0) {
		return (
			<span className="mx-device">
				<span className="tx">
					<b>{deviceName}</b>
					<small>{t.detail.thisDevice}</small>
				</span>
				{canRevoke && (
					<button type="button" className="btn btn-sm btn-danger" onClick={() => onRevoke(null)}>
						{t.detail.revokeThis}
					</button>
				)}
			</span>
		);
	}
	return (
		<ul className="mx-device-list">
			{devices.map((device) => {
				const key = keyText(device.publicKey);
				const mine = myKey !== null && sameKey(device.publicKey, myKey);
				const added = Number(device.addedAt);
				const name = device.name || t.detail.unnamedDevice;
				return (
					<li key={key} className="mx-device">
						<span className="tx">
							<b>{name}</b>
							<small>
								{mine && <span className="mx-tag">{t.detail.thisDevice}</span>}
								{added > 0 && t.detail.pairedAt(new Date(added).toLocaleDateString(locale, { day: "2-digit", month: "2-digit", year: "numeric" }))}
							</small>
						</span>
						{revoked.has(key) ? (
							<span className="muted">{t.detail.revoked}</span>
						) : (
							canRevoke && (
								<button type="button" className="btn btn-sm btn-danger" aria-label={`${t.detail.revokeThis}: ${name}`} onClick={() => onRevoke(device)}>
									{t.detail.revokeThis}
								</button>
							)
						)}
					</li>
				);
			})}
		</ul>
	);
}
