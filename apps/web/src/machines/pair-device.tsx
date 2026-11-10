// "Ghép thiết bị này": pairing this device with a machine it has never
// talked to (being signed in to the same account is not enough). The user
// types the 6-digit code their Authenticator app shows for the machine; the
// code goes through CPace, so neither the chat server nor the tunnel learns
// it. Nothing to run on the machine: this works from a phone far from it. On
// success the machine key is pinned and the link opens.
import { useEffect, useState, type ReactElement } from "react";
import { HandshakeErrorCode } from "@achoo254/chat-proto/remote/remote";
import { HandshakeFailure, PakeFailure } from "@achoo254/chat-remote-protocol";
import { Icon } from "../components/screen-icons.tsx";
import { CopyButton } from "../messaging/ui/parts.tsx";
import { Link, navigate, paths } from "../router.tsx";
import type { MachinesCopy } from "./copy-vi.ts";
import { CodeInput } from "./code-input.tsx";
import { pairWithCode } from "./link/pairing.ts";
import type { LinkHub } from "./link/link-hub.ts";
import { MachineIcon } from "./machine-icons.tsx";
import { PageHead } from "./page-head.tsx";
import { useEntry, useHub, useNow } from "./use-machines.ts";
import { reachable } from "./machine-status.ts";
import { useI18n } from "../i18n/i18n.tsx";
import { serverOrigin } from "../server-origin.ts";
import { type Os, quickInstallCommand } from "./add-machine.tsx";
import { useMachinesCopy } from "./use-machines-copy.ts";

/** Why a pairing failed, as the page explains it. */
export type PairProblem = "wrong" | "tooMany" | "notSet" | "version" | "unreachable" | "generic";

export function pairProblem(err: unknown): PairProblem {
	// The machine never says "wrong code": no candidate it sent matched what was typed.
	if (err instanceof PakeFailure) return "wrong";
	if (err instanceof HandshakeFailure) {
		switch (err.code) {
			case HandshakeErrorCode.TOTP_NOT_SET:
				return "notSet";
			case HandshakeErrorCode.TOO_MANY_ATTEMPTS:
				return "tooMany";
			case HandshakeErrorCode.BAD_PROOF:
				return "wrong";
			case HandshakeErrorCode.VERSION_UNSUPPORTED:
				return "version";
			default:
				return "generic";
		}
	}
	return "unreachable";
}

/** One line for `problem`; the page shows "notSet" with its steps (PairProblemView). */
export function pairProblemText(t: MachinesCopy, problem: PairProblem, machine: string): string {
	switch (problem) {
		case "wrong":
			return t.pair.wrong;
		case "tooMany":
			return t.pair.tooMany(machine);
		case "notSet":
			return `${t.pair.notSetTitle(machine)}. ${t.pair.notSetHow}`;
		case "version":
			return t.link.version;
		case "unreachable":
			return t.pair.unreachable;
		case "generic":
			return t.errors.generic;
	}
}

/** Pairs with the machine at `url` by its Authenticator code, pins its key under `ref`. */
export async function pairByCode(hub: LinkHub, ref: string, url: string, code: string): Promise<void> {
	const device = await hub.deps.keys.device();
	const machineKey = await pairWithCode({ url, device, deviceName: hub.deps.deviceName, socket: hub.deps.socket }, code);
	await hub.pinned(ref, machineKey);
}

export function PairDevice({ machine }: { machine: string }): ReactElement {
	const t = useMachinesCopy();
	const hub = useHub();
	const entry = useEntry(hub, machine);
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<PairProblem | null>(null);
	/** Bumped after each failure: the boxes clear for the next code. */
	const [attempt, setAttempt] = useState(0);
	const name = entry?.name ?? "";
	const now = useNow();
	// The code goes to the machine through its tunnel: only while the directory sees it online.
	const online = entry !== null && reachable(entry, now);
	const url = online ? (entry?.tunnelUrl ?? "") : "";

	// Offline: ask the directory every few seconds, so the code boxes open as soon as the machine is up.
	useEffect(() => {
		if (online) return;
		const ask = () => void hub.refresh().catch(() => undefined);
		ask();
		const timer = window.setInterval(ask, OFFLINE_POLL_MS);
		return () => window.clearInterval(timer);
	}, [hub, online]);

	const pair = (code: string) => {
		setBusy(true);
		setProblem(null);
		pairByCode(hub, machine, url, code).then(
			() => navigate(paths.machine(machine)),
			(err: unknown) => {
				setBusy(false);
				setProblem(pairProblem(err));
				setAttempt((n) => n + 1);
			},
		);
	};

	return (
		<div className="mx-scroll">
			<PageHead back={paths.machine(machine)} title={t.pair.title} subtitle={name} />
			<div className="mx-body">
				<div className="card pad mx-card narrow">
					<h3>
						<MachineIcon name="shield" />
						{t.pair.heading(name)}
					</h3>
					{entry !== null && !online ? (
						<NotConnected name={name} machineOs={entry.os} />
					) : (
						<div className="stack" data-id="pair-code">
							<p>{t.pair.intro(name)}</p>
							<CodeInput key={attempt} label={t.pair.code} disabled={busy || url === ""} onCode={pair} />
						</div>
					)}
					{busy && (
						<div className="mx-wait" role="status">
							<span className="spin" aria-hidden="true" />
							{t.pair.pairing}
						</div>
					)}
					{problem !== null && <PairProblemView problem={problem} machine={name} />}
					<div className="mx-hint">
						<Icon name="lock" small />
						<span>{t.pair.note}</span>
					</div>
				</div>
			</div>
		</div>
	);
}

/** What went wrong; a machine without Authenticator pairing also gets the two ways to turn it on. */
export function PairProblemView({ problem, machine }: { problem: PairProblem; machine: string }): ReactElement {
	const t = useMachinesCopy();
	if (problem !== "notSet") {
		return (
			<p className="mx-error" role="alert" data-id="pair-error">
				{pairProblemText(t, problem, machine)}
			</p>
		);
	}
	return (
		<div className="mx-pair-offline" role="alert" data-id="pair-not-set">
			<h4>
				<Icon name="alert" small />
				{t.pair.notSetTitle(machine)}
			</h4>
			<p>{t.pair.notSetHow}</p>
			<p>{t.pair.notSetReinstall}</p>
			<div>
				<Link to={paths.machinesAdd()} className="btn btn-sm" data-id="pair-not-set-install">
					{t.pair.getInstall}
				</Link>
			</div>
		</div>
	);
}

export const OFFLINE_POLL_MS = 5_000;

/**
 * The machine is not reachable now (switched off or asleep, tunelo not
 * running, or an old version without the tunnel): what to do on it. The page
 * opens the code boxes by itself once it is up.
 */
function NotConnected({ name, machineOs }: { name: string; machineOs: string }): ReactElement {
	const t = useMachinesCopy();
	const p = t.agent.pairing;
	const os = osOf(machineOs);
	return (
		<div className="mx-pair-offline" role="status" data-id="pair-offline">
			<h4>{p.offlineTitle(name)}</h4>
			<p>{p.offlineWhy}</p>
			<ol className="mx-steps">
				<li>
					<QuickInstall machineOs={machineOs} />
				</li>
				<li>
					<p>{os === "windows" ? p.startWindows : p.startMac}</p>
					<div className="mx-cmd">
						<code>tunelo start</code>
						<CopyButton text="tunelo start" label={t.addMachine.copy} copiedLabel={t.addMachine.copied} small />
					</div>
				</li>
			</ol>
			<p className="mx-wait">
				<span className="spin" aria-hidden="true" />
				{p.offlineWaiting}
			</p>
		</div>
	);
}

/** The machine's system as the directory knows it: "darwin", "win32", or unknown. */
function osOf(machineOs: string): Os | null {
	return machineOs === "win32" ? "windows" : machineOs === "darwin" ? "mac" : null;
}

/** "Máy chưa có tunelo?": the one command that installs it, for the machine's system (chosen here when unknown). */
export function QuickInstall({ machineOs }: { machineOs: string }): ReactElement {
	const t = useMachinesCopy();
	const q = t.agent.pairing;
	const { locale } = useI18n();
	const known = osOf(machineOs);
	const [picked, setPicked] = useState<Os>("mac");
	const os = known ?? picked;
	const command = quickInstallCommand(os, serverOrigin(), locale);
	return (
		<div className="mx-quick-install" data-id="pair-quick-install">
			<p className="note">
				<strong>{q.noTunelo}</strong> {os === "windows" ? q.installWindows : q.installMac}
			</p>
			{known === null && (
				<div className="mx-new-tabs" role="group" aria-label={q.systemLabel}>
					{(["mac", "windows"] as const).map((o) => (
						<button key={o} type="button" className={`btn btn-sm${o === os ? " btn-primary" : ""}`} aria-pressed={o === os} onClick={() => setPicked(o)}>
							{o === "mac" ? "macOS" : "Windows"}
						</button>
					))}
				</div>
			)}
			<div className="mx-cmd">
				<code>{command}</code>
				<CopyButton text={command} label={t.addMachine.copy} copiedLabel={t.addMachine.copied} small />
			</div>
			<p className="note">{os === "windows" ? q.notFoundWindows : q.notFoundMac}</p>
		</div>
	);
}
