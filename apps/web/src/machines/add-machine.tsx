// "Thêm máy này", done in the browser of the machine to add: (1) the AI CLI is
// installed and signed in, (2) one command installs chat-agent with a
// one-time install code and this browser's device key, then asks for the
// pairing secret, which this page made and shows (it never goes to the
// server), (3) the page waits for the machine in the directory and checks in
// the first handshake that it knows the secret before pinning its key.
import { useEffect, useRef, useState } from "react";
import { random, toBase64Url } from "@achoo254/chat-remote-protocol";
import { brand } from "../brand.ts";
import { Icon } from "../components/screen-icons.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { CopyButton } from "../messaging/ui/parts.tsx";
import { Link, paths } from "../router.tsx";
import { serverOrigin } from "../server-origin.ts";
import { confirmTrust } from "./link/pairing.ts";
import { MachineIcon } from "./machine-icons.tsx";
import { directoryErrorReason, type MachineEntry } from "./machines-client.ts";
import { PageHead } from "./page-head.tsx";
import { useHub } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

const POLL_MS = 3_000;
/** Official install guide of the AI CLI the first adapter drives. */
const CLI_GUIDE = "https://code.claude.com/docs/en/setup";

type Os = "mac" | "windows";

function detectOs(userAgent: string): Os | "phone" {
	if (/iPhone|iPad|Android/.test(userAgent)) return "phone";
	return /Windows/.test(userAgent) ? "windows" : "mac";
}

/** The command the page shows; the pairing secret is pasted when the script asks, never part of it. */
export function installCommand(os: Os, origin: string, code: string, deviceKey: string, locale: string): string {
	return os === "windows"
		? `& ([scriptblock]::Create((irm ${origin}/agent/install.ps1))) ${code} ${deviceKey} ${locale}`
		: `curl -fsSL ${origin}/agent/install.sh | sh -s -- ${code} ${deviceKey} ${locale}`;
}

type Step =
	| { readonly kind: "start" }
	| { readonly kind: "making" }
	| { readonly kind: "waiting"; readonly code: string; readonly expiresAt: number; readonly secret: Uint8Array<ArrayBuffer>; readonly known: ReadonlySet<number> }
	| { readonly kind: "confirming"; readonly machine: MachineEntry; readonly secret: Uint8Array<ArrayBuffer> }
	| { readonly kind: "connected"; readonly machine: MachineEntry }
	| { readonly kind: "expired" };

export function AddMachine() {
	const t = useMachinesCopy();
	const { locale } = useI18n();
	const hub = useHub();
	const [os, setOs] = useState<Os | "phone">(() => detectOs(navigator.userAgent));
	const [step, setStep] = useState<Step>({ kind: "start" });
	const [deviceKey, setDeviceKey] = useState("");
	const [error, setError] = useState("");
	const busy = useRef(false);

	useEffect(() => {
		hub.deps.keys.device().then(
			(key) => setDeviceKey(toBase64Url(key.publicKey)),
			() => setError(t.errors.generic),
		);
	}, [hub, t]);

	// Wait for the new machine in the directory (it registers, then opens its tunnel).
	useEffect(() => {
		if (step.kind !== "waiting") return;
		let stopped = false;
		const timer = window.setInterval(() => {
			if (Date.now() > step.expiresAt * 1000) {
				setStep({ kind: "expired" });
				return;
			}
			if (busy.current) return;
			busy.current = true;
			hub
				.refresh()
				.then((machines) => {
					const fresh = machines.filter((m) => !step.known.has(m.id) && m.tunnelUrl !== "").sort((a, b) => b.createdAt - a.createdAt)[0];
					if (fresh !== undefined && !stopped) setStep({ kind: "confirming", machine: fresh, secret: step.secret });
				})
				.catch(() => undefined)
				.finally(() => {
					busy.current = false;
				});
		}, POLL_MS);
		return () => {
			stopped = true;
			window.clearInterval(timer);
		};
	}, [step, hub]);

	// The machine must prove the secret this page made before its key is pinned.
	useEffect(() => {
		if (step.kind !== "confirming") return;
		let active = true;
		const { machine, secret } = step;
		hub.deps.keys
			.device()
			.then((device) =>
				confirmTrust({ url: machine.tunnelUrl, device, deviceName: hub.deps.deviceName, socket: hub.deps.socket }, { kind: "install", secret }),
			)
			.then((machineKey) => hub.pinned(machine.ref, machineKey))
			.then(
				() => {
					if (active) setStep({ kind: "connected", machine });
				},
				() => {
					if (!active) return;
					setStep({ kind: "start" });
					setError(t.addMachine.failed);
				},
			);
		return () => {
			active = false;
		};
	}, [step, hub, t]);

	const make = () => {
		setError("");
		setStep({ kind: "making" });
		const known = new Set(hub.directory().machines.map((m) => m.id));
		hub.deps.directory.createInstallCode().then(
			({ code, expiresAt }) => setStep({ kind: "waiting", code, expiresAt, secret: random(32), known }),
			(err: unknown) => {
				setStep({ kind: "start" });
				setError(directoryErrorReason(err) === "rate" ? t.addMachine.rate : t.errors.generic);
			},
		);
	};

	if (os === "phone") {
		return (
			<div className="mx-scroll">
				<PageHead back={paths.machines()} backLabel={t.backToMachines} title={t.add} />
				<div className="mx-body">
					<div className="mx-hint">
						<MachineIcon name="monitor" small />
						<span>{t.addMachine.phone(brand.appName)}</span>
					</div>
				</div>
			</div>
		);
	}

	const waiting = step.kind === "waiting" ? step : null;
	const command = waiting === null || deviceKey === "" ? "" : installCommand(os, serverOrigin(), waiting.code, deviceKey, locale);
	const secret = waiting === null ? "" : toBase64Url(waiting.secret);
	const expires = waiting === null ? "" : new Date(waiting.expiresAt * 1000).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
	const done = step.kind === "connected";
	return (
		<div className="mx-scroll">
			<PageHead back={paths.machines()} backLabel={t.backToMachines} title={t.add} subtitle={t.addMachine.subtitle} />
			<div className="mx-body">
				<div className="card pad mx-card">
					<h3>
						<Icon name="plus" />
						{t.addMachine.heading}
					</h3>
					<p className="muted">{t.addMachine.intro}</p>
					<ol className="mx-steps">
						<li className="done">
							<div>
								<h4>{t.addMachine.step1}</h4>
								<p className="muted">
									{t.addMachine.step1Body}{" "}
									<a className="link" href={CLI_GUIDE} target="_blank" rel="noreferrer noopener">
										{t.addMachine.guide}
									</a>
								</p>
							</div>
						</li>
						<li className={step.kind === "confirming" || done ? "done" : undefined}>
							<div>
								<h4>{os === "windows" ? t.addMachine.step2Win : t.addMachine.step2Mac}</h4>
								<div className="choice mx-os" role="group" aria-label={t.addMachine.osTabs}>
									<button type="button" aria-pressed={os === "mac"} onClick={() => setOs("mac")}>
										{t.addMachine.macos}
									</button>
									<button type="button" aria-pressed={os === "windows"} onClick={() => setOs("windows")}>
										{t.addMachine.windows}
									</button>
								</div>
								{waiting === null ? (
									step.kind !== "confirming" &&
									!done && (
										<button type="button" className="btn btn-primary btn-sm" disabled={step.kind === "making" || deviceKey === ""} onClick={make}>
											{step.kind === "making" ? t.addMachine.making : t.addMachine.make}
										</button>
									)
								) : (
									<>
										<div className="mx-cmd">
											<code aria-label={t.addMachine.command}>{command}</code>
											<CopyButton text={command} label={t.addMachine.copy} copiedLabel={t.addMachine.copied} small />
										</div>
										<p className="muted">{t.addMachine.secret}</p>
										<div className="mx-cmd">
											<code aria-label={t.addMachine.secretLabel}>{secret}</code>
											<CopyButton text={secret} label={t.addMachine.copy} copiedLabel={t.addMachine.copied} small />
										</div>
										<p className="note">{t.addMachine.expires(expires)}</p>
									</>
								)}
								{step.kind === "expired" && (
									<p className="mx-error">
										{t.addMachine.expired}{" "}
										<button type="button" className="btn btn-sm" onClick={make}>
											{t.addMachine.make}
										</button>
									</p>
								)}
							</div>
						</li>
						<li className={done ? "done" : undefined}>
							<div>
								<h4>{t.addMachine.step3}</h4>
								{waiting !== null && (
									<div className="mx-wait">
										<span className="spin" aria-hidden="true" />
										{t.addMachine.waiting}
									</div>
								)}
								{step.kind === "confirming" && (
									<div className="mx-wait">
										<span className="spin" aria-hidden="true" />
										{t.addMachine.confirming}
									</div>
								)}
								{done && (
									<div className="mx-ok" role="status">
										<Icon name="check" small />
										{t.addMachine.connected(step.machine.name)}
										<Link to={paths.machine(step.machine.ref)} className="btn btn-primary btn-sm">
											{t.addMachine.open}
										</Link>
									</div>
								)}
							</div>
						</li>
					</ol>
					{error !== "" && (
						<p className="mx-error" role="alert">
							{error}
						</p>
					)}
					<div className="mx-hint">
						<MachineIcon name="shield" small />
						<span>{t.addMachine.e2ee(brand.appName)}</span>
					</div>
				</div>
			</div>
		</div>
	);
}
