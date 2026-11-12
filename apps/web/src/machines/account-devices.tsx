// The account's devices (MachinesService.ListDevices) in the machines
// settings: every browser and app that registered a key, with its platform,
// when it was added and last used, "this device", and revoking it
// (RevokeDevice by key). Revoking signs that device's session out and the
// machines drop it at their next heartbeat; revoking this device signs this
// page out (the next request finds the session gone).
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../i18n/i18n.tsx";
import { ConfirmDialog } from "../messaging/bots/dialogs.tsx";
import { equal } from "@achoo254/chat-remote-protocol";
import type { MachinesCopy } from "./copy-vi.ts";
import type { DeviceEntry } from "./machines-client.ts";
import { timeAgo, useHub, useNow } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

/** Hex of a device key, for React keys. */
export function keyText(key: Uint8Array): string {
	return Array.from(key, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type Devices = { readonly status: "loading" } | { readonly status: "error" } | { readonly status: "ready"; readonly list: readonly DeviceEntry[] };

function platformName(t: MachinesCopy, platform: string): string {
	return t.devices.platform[platform] ?? platform;
}

export function AccountDevices() {
	const t = useMachinesCopy();
	const { locale } = useI18n();
	const hub = useHub();
	const now = useNow();
	const [devices, setDevices] = useState<Devices>({ status: "loading" });
	const [target, setTarget] = useState<DeviceEntry | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	const load = useCallback(() => {
		let live = true;
		// This device registers first, so the list marks it.
		hub
			.device()
			.catch(() => undefined)
			.then(() => hub.deps.directory.devices())
			.then(
				(list) => {
					if (live) setDevices({ status: "ready", list });
				},
				() => {
					if (live) setDevices({ status: "error" });
				},
			);
		return () => {
			live = false;
		};
	}, [hub]);
	useEffect(() => load(), [load]);

	const date = (seconds: number) => new Date(seconds * 1000).toLocaleDateString(locale, { day: "2-digit", month: "2-digit", year: "numeric" });
	const revoke = (device: DeviceEntry) => {
		setBusy(true);
		setError("");
		hub.deps.directory.revokeDevice(device.publicKey).then(
			() => {
				setBusy(false);
				setTarget(null);
				setDevices((current) =>
					current.status !== "ready"
						? current
						: { status: "ready", list: current.list.map((d) => (equal(d.publicKey, device.publicKey) ? { ...d, revokedAt: Math.floor(Date.now() / 1000) } : d)) },
				);
				// This device's session is gone: the next request signs the page out.
				if (device.current) load();
			},
			() => {
				setBusy(false);
				setError(t.errors.generic);
			},
		);
	};

	return (
		<section className="card pad mx-card" data-id="account-devices" aria-labelledby="account-devices-title">
			<h3 id="account-devices-title">{t.devices.title}</h3>
			<p className="note">{t.devices.intro}</p>
			{devices.status === "loading" && <p className="muted">{t.devices.loading}</p>}
			{devices.status === "error" && (
				<p className="mx-error" role="alert">
					{t.devices.failed}{" "}
					<button
						type="button"
						className="btn btn-sm"
						onClick={() => {
							setDevices({ status: "loading" });
							load();
						}}
					>
						{t.devices.retry}
					</button>
				</p>
			)}
			{devices.status === "ready" && devices.list.length === 0 && <p className="muted">{t.devices.empty}</p>}
			{devices.status === "ready" && devices.list.length > 0 && (
				<ul className="mx-device-list" data-id="account-devices-list">
					{devices.list.map((device) => {
						const name = device.name || t.devices.unnamed;
						const live = device.revokedAt === 0;
						const facts = [
							platformName(t, device.platform),
							t.devices.added(date(device.createdAt)),
							live ? (device.lastSeenAt > 0 ? t.devices.lastSeen(timeAgo(t, device.lastSeenAt * 1000, now)) : t.devices.neverUsed) : t.devices.revokedAt(date(device.revokedAt)),
						];
						return (
							<li key={keyText(device.publicKey)} className={live ? "mx-device" : "mx-device revoked"} data-id="account-device">
								<span className="tx">
									<b>{name}</b>
									<small>
										{device.current && <span className="mx-tag">{t.devices.thisDevice}</span>}
										{facts.join(" · ")}
									</small>
								</span>
								{live && (
									<button
										type="button"
										className="btn btn-sm danger-outline"
										aria-label={`${t.devices.revoke}: ${name}`}
										onClick={() => {
											setError("");
											setTarget(device);
										}}
									>
										{t.devices.revoke}
									</button>
								)}
							</li>
						);
					})}
				</ul>
			)}
			{error !== "" && target === null && (
				<p className="mx-error" role="alert">
					{error}
				</p>
			)}
			{target !== null && (
				<ConfirmDialog
					title={target.current ? t.devices.revokeSelfTitle : t.devices.revokeTitle(target.name || t.devices.unnamed)}
					body={
						<>
							<p>{target.current ? t.devices.revokeSelfBody : t.devices.revokeBody}</p>
							{error !== "" && (
								<p className="mx-error" role="alert">
									{error}
								</p>
							)}
						</>
					}
					action={t.devices.revoke}
					busyLabel={t.devices.revoking}
					busy={busy}
					danger
					onConfirm={() => revoke(target)}
					onClose={() => setTarget(null)}
				/>
			)}
		</section>
	);
}
