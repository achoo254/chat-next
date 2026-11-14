// "Quản lý máy" (/ai/machines): the user's machines, one card each in the
// page's column. A card says which machine it is (its system's glyph, its
// short name, the whole host name), how it is (online, offline since when,
// or what it needs, with tunelo's version and a newer one when there is),
// what it holds (system, projects, sessions running, the terminal), and
// what to do there: its overview, a plain terminal (only while it is
// reachable, else said why), its settings. Without machines: how to add one.
// Below them, the account's devices (account-devices.tsx).
import type { MachineInfo } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../components/screen-icons.tsx";
import { Link, navigate, paths } from "../router.tsx";
import { aiPaths } from "./ai-paths.ts";
import { terminalGate } from "./agent-version.ts";
import type { MachinesCopy } from "./copy-vi.ts";
import { MachineIcon } from "./machine-icons.tsx";
import { AccountDevices } from "./account-devices.tsx";
import { failureText } from "./link-banner.tsx";
import { isBlocked, type Conn } from "./machine-status.ts";
import { PageHead } from "./page-head.tsx";
import { shortHost } from "./project-tree.ts";
import { connText } from "./session-row.tsx";
import { connDot } from "./session-sidebar.tsx";
import { isRunning, useHub, useMachineViews, useNow, type MachineView } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

type Tone = "ok" | "off" | "wait" | "attention";

/** The status pill's colour: online, offline, on its way, or something for the user to do. */
export function toneOf(conn: Conn): Tone {
	const dot = connDot(conn);
	return dot === "on" ? "ok" : dot === "off" ? "off" : dot === "wait" ? "wait" : "attention";
}

/** The system's glyph: an apple, four panes, a penguin's outline, else a screen. */
function OsGlyph({ os }: { os: string }) {
	if (os === "darwin") {
		return (
			<svg viewBox="0 0 24 24" aria-hidden="true">
				<path
					fill="currentColor"
					d="M16.4 12.6c0-2.2 1.8-3.3 1.9-3.4-1-1.5-2.6-1.7-3.2-1.7-1.4-.1-2.7.8-3.4.8s-1.8-.8-2.9-.8c-1.5 0-2.9.9-3.7 2.2-1.6 2.7-.4 6.8 1.1 9 .8 1.1 1.7 2.3 2.8 2.2 1.1 0 1.6-.7 2.9-.7s1.7.7 2.9.7 2-1.1 2.7-2.2c.9-1.2 1.2-2.4 1.2-2.5 0 0-2.3-.9-2.3-3.6zM14.2 6.1c.6-.7 1-1.7.9-2.7-.9 0-1.9.6-2.5 1.3-.6.6-1 1.6-.9 2.6 1 .1 1.9-.5 2.5-1.2z"
				/>
			</svg>
		);
	}
	if (os === "win32" || os === "windows") {
		return (
			<svg viewBox="0 0 24 24" aria-hidden="true">
				<path fill="currentColor" d="M3 5.5 10.5 4.4v7.1H3zM11.5 4.3 21 3v8.5h-9.5zM3 12.5h7.5v7.1L3 18.5zM11.5 12.5H21V21l-9.5-1.3z" />
			</svg>
		);
	}
	if (os === "linux") {
		return (
			<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
				<path d="M12 3c-2.2 0-3.4 1.9-3.4 4.4 0 1.6-.6 2.7-1.6 4.2-1.2 1.8-2 3.6-1.5 5.6.4 1.6 2.2 2.8 6.5 2.8s6.1-1.2 6.5-2.8c.5-2-.3-3.8-1.5-5.6-1-1.5-1.6-2.6-1.6-4.2C15.4 4.9 14.2 3 12 3z" />
				<circle cx="10.5" cy="7.6" r=".6" fill="currentColor" />
				<circle cx="13.5" cy="7.6" r=".6" fill="currentColor" />
				<path d="M10.8 9.6h2.4l-1.2 1z" fill="currentColor" />
			</svg>
		);
	}
	return <MachineIcon name="monitor" />;
}

/** What the machine holds, as far as it told this page: system, projects, sessions running, the terminal. */
function facts(t: MachinesCopy, machine: MachineView): string[] {
	const { entry, state } = machine;
	const out: string[] = [];
	if (entry.os !== "") out.push(t.os(entry.os, entry.arch));
	const projects = state.projects?.projects.length;
	if (projects !== undefined) out.push(t.machinesPage.projects(projects));
	if (state.listed) out.push(t.machinesPage.running(state.threads.filter((x) => isRunning(x)).length));
	if (terminalGate(state.info) === "available") out.push(t.machinesPage.terminalReady);
	return out;
}

/** The newest tunelo when it is newer than the machine's. */
function newerVersion(info: MachineInfo | null): string {
	return info?.agentUpdate?.latestVersion ?? "";
}

function MachineCard({ machine, now }: { machine: MachineView; now: number }) {
	const t = useMachinesCopy();
	const m = t.machinesPage;
	const { entry, conn, state } = machine;
	const short = shortHost(entry.name);
	const tone = toneOf(conn);
	const online = conn.kind === "on";
	const version = state.info?.agentVersion || entry.agentVersion;
	const newer = newerVersion(state.info);
	const shell = terminalGate(state.info) === "available";
	// Why a plain terminal cannot open now, when it cannot.
	const shellBlocked = !online ? m.needsOnline : !shell ? m.noTerminal : "";
	return (
		<li className="mx-mcard" data-tone={tone} data-id="machine-card">
			<div className="mx-mcard-head">
				<span className="mx-mcard-os" aria-hidden="true">
					<OsGlyph os={entry.os} />
				</span>
				<span className="mx-mcard-name">
					<Link to={paths.machineInfo(entry.ref)} className="mx-mcard-title" title={entry.name}>
						{short}
					</Link>
					{short !== entry.name && <small title={entry.name}>{entry.name}</small>}
				</span>
				<span className="mx-mcard-status">
					<span className="mx-pill" data-tone={tone} role="status">
						<span className="dot" aria-hidden="true" />
						{connText(t, conn, now)}
					</span>
					{version !== "" && <small className="mx-mcard-ver">{m.version(version)}</small>}
				</span>
			</div>
			{(newer !== "" || isBlocked(conn)) && <p className="mx-mcard-note">{newer !== "" ? m.update(newer) : isBlocked(conn) ? failureText(t, conn.reason) : ""}</p>}
			<p className="mx-mcard-facts">{facts(t, machine).join(" · ")}</p>
			<div className="mx-mcard-acts" role="group" aria-label={m.actions(short)}>
				<Link to={paths.machine(entry.ref)} className="btn btn-sm">
					<MachineIcon name="ai-board" small />
					{t.agent.machineBoard}
				</Link>
				{/* A disabled button shows no tooltip: the reason sits on its wrapper (and in its accessible name). */}
				<span className="mx-mcard-wrap" title={shellBlocked !== "" ? shellBlocked : undefined}>
					<button
						type="button"
						className="btn btn-sm"
						disabled={shellBlocked !== ""}
						aria-label={shellBlocked !== "" ? `${t.terminal.newTab}: ${shellBlocked}` : undefined}
						onClick={() => navigate(aiPaths.newShell(entry.ref, ""))}
					>
						<MachineIcon name="terminal" small />
						{t.terminal.newTab}
					</button>
				</span>
				<Link to={paths.machineInfo(entry.ref)} className="btn btn-sm mx-btn-ghost">
					<Icon name="settings" small />
					{t.agent.info}
				</Link>
			</div>
		</li>
	);
}

/** "Quản lý máy": every machine as a card; adding one. */
export function MachinesPage() {
	const t = useMachinesCopy();
	const hub = useHub();
	const now = useNow();
	const machines = useMachineViews(hub, now);
	const directory = hub.directory();
	return (
		<div className="mx-scroll">
			<PageHead back={paths.machines()} backLabel={t.backToMachines} title={t.agent.machinesTitle} subtitle={t.agent.machinesIntro}>
				<Link to={paths.machinesAdd()} className="btn btn-primary btn-sm">
					<Icon name="plus" small />
					{t.agent.addMachine}
				</Link>
			</PageHead>
			{directory.status === "error" && (
				<div className="mx-strip error" role="alert">
					<Icon name="alert" small />
					<span className="grow">{t.errors.generic}</span>
					<button type="button" className="btn btn-sm" onClick={() => hub.refresh().catch(() => undefined)}>
						{t.link.retry}
					</button>
				</div>
			)}
			<div className="mx-body">
				{directory.status === "ready" && machines.length === 0 ? (
					<div className="mx-mempty" data-id="machines-empty">
						<span className="mx-mcard-os" aria-hidden="true">
							<MachineIcon name="monitor" />
						</span>
						<h2>{t.machinesPage.empty}</h2>
						<p>{t.machinesPage.emptyHint}</p>
						<Link to={paths.machinesAdd()} className="btn btn-primary">
							<Icon name="plus" small />
							{t.agent.addMachine}
						</Link>
					</div>
				) : (
					<ul className="mx-mcards">
						{machines.map((m) => (
							<MachineCard key={m.entry.ref} machine={m} now={now} />
						))}
					</ul>
				)}
				<AccountDevices />
				{import.meta.env.DEV && (
					<Link to={paths.machinesLocal()} className="link">
						{t.local.entry}
					</Link>
				)}
			</div>
		</div>
	);
}
