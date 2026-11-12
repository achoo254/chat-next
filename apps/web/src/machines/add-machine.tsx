// "Thêm máy này", done in the browser of the machine to add: (1) the AI CLI is
// installed and signed in, (2) one fixed command (no code, no key: the same
// for everyone) installs tunelo and runs `tunelo login`, which opens this
// browser on the account's consent page; once allowed, tunelo adds the
// machine to the account by itself, (3) the page watches the directory and
// says "connected" as soon as a new machine (or one of the account's
// machines that was offline) comes online. Any device signed in to the
// account can use it then: the account is the anchor of trust.
import { useEffect, useRef, useState } from "react";
import { brand } from "../brand.ts";
import { Icon } from "../components/screen-icons.tsx";
import { CopyButton } from "../messaging/ui/parts.tsx";
import { Link, paths } from "../router.tsx";
import { aiPaths } from "./ai-paths.ts";
import { serverOrigin } from "../server-origin.ts";
import { MachineIcon } from "./machine-icons.tsx";
import { reachable } from "./machine-status.ts";
import type { MachineEntry } from "./machines-client.ts";
import { PageHead } from "./page-head.tsx";
import { useHub } from "./use-machines.ts";
import { DiskAccessGuide } from "./disk-access-guide.tsx";
import { useMachinesCopy } from "./use-machines-copy.ts";

const POLL_MS = 3_000;
/** A forgotten tab stops asking after this long; "Check again" resumes. */
const WAIT_MS = 15 * 60_000;
/** Official install guide of the AI CLI the first adapter drives. */
export const CLI_GUIDE = "https://code.claude.com/docs/en/setup";

export type Os = "mac" | "windows" | "linux";

/** Windows first, then Mac, then desktop Linux; ChromeOS ("CrOS") and anything else fall back to Mac. */
export function detectOs(userAgent: string): Os | "phone" {
	if (/iPhone|iPad|Android/.test(userAgent)) return "phone";
	if (/Windows/.test(userAgent)) return "windows";
	if (/Macintosh|Mac OS X/.test(userAgent)) return "mac";
	return /Linux/.test(userAgent) && !/CrOS/.test(userAgent) ? "linux" : "mac";
}

/** The shells the page has a command for. */
export type InstallTab = "mac" | "powershell" | "cmd" | "linux";

export const INSTALL_TABS: readonly InstallTab[] = ["mac", "powershell", "cmd", "linux"];

/** The tab shown first: Windows opens on PowerShell. */
export function defaultTab(os: Os): InstallTab {
	return os === "windows" ? "powershell" : os;
}

/**
 * The one command of each tab. It carries nothing of the account or of this
 * browser: the scripts take no arguments, and signing in happens in the
 * browser tunelo opens. cmd runs the PowerShell script as one line.
 */
export function installCommand(tab: InstallTab, origin: string): string {
	switch (tab) {
		case "mac":
		case "linux":
			return `curl -fsSL ${origin}/agent/install.sh | sh`;
		case "powershell":
			return `irm ${origin}/agent/install.ps1 | iex`;
		case "cmd":
			return `powershell -NoProfile -c "irm ${origin}/agent/install.ps1 | iex"`;
	}
}

/**
 * The machine the page waits for, from two readings of the directory: a
 * machine that was not listed before and is online now, else one that was
 * listed offline and came online (tunelo installed again on it). The newest
 * first; null while there is none.
 */
export function arrivedMachine(before: ReadonlyMap<number, boolean>, machines: readonly MachineEntry[], nowMs: number): MachineEntry | null {
	const online = machines.filter((m) => reachable(m, nowMs));
	const fresh = online.filter((m) => !before.has(m.id)).sort((a, b) => b.createdAt - a.createdAt)[0];
	return fresh ?? online.find((m) => before.get(m.id) === false) ?? null;
}

/** Each machine of the directory: online now or not. */
function onlineById(machines: readonly MachineEntry[], nowMs: number): ReadonlyMap<number, boolean> {
	return new Map(machines.map((m) => [m.id, reachable(m, nowMs)]));
}

type Wait =
	| { readonly kind: "waiting"; readonly until: number }
	| { readonly kind: "stale" }
	| { readonly kind: "connected"; readonly machine: MachineEntry };

export function AddMachine() {
	const t = useMachinesCopy();
	const hub = useHub();
	const os = detectOs(navigator.userAgent);
	const [tab, setTab] = useState<InstallTab>(() => defaultTab(os === "phone" ? "mac" : os));
	const [wait, setWait] = useState<Wait>(() => ({ kind: "waiting", until: Date.now() + WAIT_MS }));
	const [error, setError] = useState("");
	/** The directory as the page first read it; null until then. */
	const before = useRef<ReadonlyMap<number, boolean> | null>(null);
	const busy = useRef(false);

	// Watch the directory: tunelo adds the machine once the user allowed it, then opens its tunnel.
	useEffect(() => {
		if (os === "phone" || wait.kind !== "waiting") return;
		let stopped = false;
		const check = () => {
			if (Date.now() > wait.until) {
				setWait({ kind: "stale" });
				return;
			}
			if (busy.current) return;
			busy.current = true;
			hub
				.refresh()
				.then((machines) => {
					if (stopped) return;
					setError("");
					const now = Date.now();
					if (before.current === null) {
						before.current = onlineById(machines, now);
						return;
					}
					const machine = arrivedMachine(before.current, machines, now);
					if (machine !== null) setWait({ kind: "connected", machine });
				})
				.catch(() => {
					if (!stopped) setError(t.errors.generic);
				})
				.finally(() => {
					busy.current = false;
				});
		};
		check();
		const timer = window.setInterval(check, POLL_MS);
		return () => {
			stopped = true;
			window.clearInterval(timer);
		};
	}, [os, wait, hub, t]);

	if (os === "phone") {
		return (
			<div className="mx-scroll">
				<PageHead back={aiPaths.manage} backLabel={t.agent.machinesTitle} title={t.add} />
				<div className="mx-body">
					<div className="mx-hint">
						<MachineIcon name="monitor" small />
						<span>{t.addMachine.phone(brand.appName)}</span>
					</div>
				</div>
			</div>
		);
	}

	const command = installCommand(tab, serverOrigin());
	const done = wait.kind === "connected";
	const tabName: Readonly<Record<InstallTab, string>> = {
		mac: t.addMachine.macos,
		powershell: t.addMachine.powershell,
		cmd: t.addMachine.cmd,
		linux: t.addMachine.linux,
	};
	return (
		<div className="mx-scroll">
			<PageHead back={aiPaths.manage} backLabel={t.agent.machinesTitle} title={t.add} subtitle={t.addMachine.subtitle} />
			<div className="mx-body">
				<section className="card pad mx-card" data-id="add-machine">
					<h3>{t.addMachine.heading}</h3>
					<p className="muted">{t.addMachine.intro}</p>
					<ol className="mx-steps">
						<li data-id="add-machine-cli">
							<h4>{t.addMachine.step1}</h4>
							<p className="muted">
								{t.addMachine.step1Body}{" "}
								<a className="link mx-ext" href={CLI_GUIDE} target="_blank" rel="noreferrer noopener" data-id="add-machine-cli-guide">
									{t.addMachine.guide}
									<Icon name="external" small />
								</a>
							</p>
						</li>
						<li className={done ? "is-done" : "is-current"} data-id="add-machine-command">
							<h4>{t.addMachine.step2}</h4>
							<div className="choice" role="group" aria-label={t.addMachine.osTabs} data-id="add-machine-tabs">
								{INSTALL_TABS.map((key) => (
									<button key={key} type="button" aria-pressed={tab === key} onClick={() => setTab(key)} data-id={`add-machine-tab-${key}`}>
										{tabName[key]}
									</button>
								))}
							</div>
							{tab === "linux" && (
								<p className="note" data-id="add-machine-linux-note">
									{t.addMachine.linuxNote}
								</p>
							)}
							<div className="mx-cmd" data-id="add-machine-command-text">
								<code aria-label={t.addMachine.command}>{command}</code>
								<CopyButton text={command} label={t.addMachine.copy} copiedLabel={t.addMachine.copied} small />
							</div>
							<p className="note">{t.addMachine.note}</p>
							<p className="note">{t.addMachine.remote}</p>
						</li>
						<li className={done ? "is-done" : undefined} data-id="add-machine-wait">
							<h4>{t.addMachine.step3}</h4>
							{wait.kind === "waiting" && (
								<div className="mx-wait" role="status">
									<span className="spin" aria-hidden="true" />
									{t.addMachine.waiting}
								</div>
							)}
							{wait.kind === "stale" && (
								<div className="mx-wait">
									<span className="muted">{t.addMachine.stale}</span>
									<button type="button" className="btn btn-sm" onClick={() => setWait({ kind: "waiting", until: Date.now() + WAIT_MS })}>
										{t.addMachine.checkAgain}
									</button>
								</div>
							)}
							{wait.kind === "connected" && (
								<div className="mx-ok" role="status" data-id="add-machine-connected">
									<Icon name="check" small />
									{t.addMachine.connected(wait.machine.name)}
									<Link to={paths.machine(wait.machine.ref)} className="btn btn-primary btn-sm">
										{t.addMachine.open}
									</Link>
								</div>
							)}
						</li>
						{tab === "mac" && (
							<li className={done ? "is-current" : undefined} data-id="add-machine-disk-access">
								<h4>{t.diskAccess.addStep}</h4>
								<p className="muted">{t.diskAccess.addBody}</p>
								<DiskAccessGuide />
							</li>
						)}
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
				</section>
			</div>
		</div>
	);
}
