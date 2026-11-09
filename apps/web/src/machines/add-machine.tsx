// "Thêm máy này", done in the browser of the machine to add: (1) the AI CLI is
// installed and signed in, (2) one command installs tunelo with this
// browser's device key, then asks for the pairing secret, which this page
// made and shows (it never goes to the server), and signs tunelo in with the
// account (tunelo login): tunelo then adds the machine to My machines by
// itself, without an install code, (3) the page waits for the new machine in
// the directory and checks in the first handshake that it knows the secret
// before pinning its key.
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
import type { MachineEntry } from "./machines-client.ts";
import { PageHead } from "./page-head.tsx";
import { useHub } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

const POLL_MS = 3_000;
/** A forgotten tab stops asking after this long; "Check again" resumes. */
const WAIT_MS = 15 * 60_000;
/** Official install guide of the AI CLI the first adapter drives. */
const CLI_GUIDE = "https://code.claude.com/docs/en/setup";

type Os = "mac" | "windows";

function detectOs(userAgent: string): Os | "phone" {
	if (/iPhone|iPad|Android/.test(userAgent)) return "phone";
	return /Windows/.test(userAgent) ? "windows" : "mac";
}

/** Installs tunelo and signs it in, without pairing: also moves a computer still running hda (the earlier name). */
export function migrateCommand(os: Os, origin: string, locale: string): string {
	return os === "windows" ? `& ([scriptblock]::Create((irm ${origin}/agent/install.ps1))) ${locale}` : `curl -fsSL ${origin}/agent/install.sh | sh -s -- ${locale}`;
}

/** The one command the page shows; the one-time pairing secret rides in it, so nothing is pasted later. */
export function installCommand(os: Os, origin: string, deviceKey: string, secret: string, locale: string): string {
	return os === "windows"
		? `& ([scriptblock]::Create((irm ${origin}/agent/install.ps1))) ${deviceKey} ${secret} ${locale}`
		: `curl -fsSL ${origin}/agent/install.sh | sh -s -- ${deviceKey} ${secret} ${locale}`;
}

type Step =
	| { readonly kind: "start" }
	| { readonly kind: "making" }
	| { readonly kind: "waiting"; readonly secret: Uint8Array<ArrayBuffer>; readonly known: ReadonlySet<number>; readonly until: number }
	| { readonly kind: "stale"; readonly secret: Uint8Array<ArrayBuffer>; readonly known: ReadonlySet<number> }
	| { readonly kind: "confirming"; readonly machine: MachineEntry; readonly secret: Uint8Array<ArrayBuffer> }
	| { readonly kind: "connected"; readonly machine: MachineEntry };

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

	// Wait for the new machine in the directory (tunelo adds it once signed in, then opens its tunnel).
	useEffect(() => {
		if (step.kind !== "waiting") return;
		let stopped = false;
		const timer = window.setInterval(() => {
			if (Date.now() > step.until) {
				setStep({ kind: "stale", secret: step.secret, known: step.known });
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

	// The machines already listed are not the new one: read the directory first.
	const make = () => {
		setError("");
		setStep({ kind: "making" });
		hub.refresh().then(
			(machines) => setStep({ kind: "waiting", secret: random(32), known: new Set(machines.map((m) => m.id)), until: Date.now() + WAIT_MS }),
			() => {
				setStep({ kind: "start" });
				setError(t.errors.generic);
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

	const waiting = step.kind === "waiting" || step.kind === "stale" ? step : null;
	const checkAgain = () => {
		if (step.kind === "stale") setStep({ kind: "waiting", secret: step.secret, known: step.known, until: Date.now() + WAIT_MS });
	};
	const command = waiting === null || deviceKey === "" ? "" : installCommand(os, serverOrigin(), deviceKey, toBase64Url(waiting.secret), locale);
	const done = step.kind === "connected";
	const fromHda = migrateCommand(os, serverOrigin(), locale);
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
										<p className="note">{t.addMachine.note}</p>
									</>
								)}
							</div>
						</li>
						<li className={done ? "done" : undefined}>
							<div>
								<h4>{t.addMachine.step3}</h4>
								{step.kind === "waiting" && (
									<div className="mx-wait">
										<span className="spin" aria-hidden="true" />
										{t.addMachine.waiting}
									</div>
								)}
								{step.kind === "stale" && (
									<p className="mx-wait">
										{t.addMachine.stale}{" "}
										<button type="button" className="btn btn-sm" onClick={checkAgain}>
											{t.addMachine.checkAgain}
										</button>
									</p>
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
					<p className="muted">{t.addMachine.fromHda}</p>
					<div className="mx-cmd">
						<code aria-label={t.addMachine.command}>{fromHda}</code>
						<CopyButton text={fromHda} label={t.addMachine.copy} copiedLabel={t.addMachine.copied} small />
					</div>
				</div>
			</div>
		</div>
	);
}
