// A folder macOS protects (tunelo 3.17.0+). tunelo keeps only the
// permissions macOS gives any program, as Claude Code in Terminal does, and
// never asks for Full Disk Access: it stays out of Desktop, Documents,
// Downloads, iCloud Drive, cloud providers' folders and other volumes until
// the user agrees here. When the machine refuses work in one, this asks
// whether tunelo may ask macOS for that folder; once agreed, it follows the
// machine's answer (MachineInfo.mac_folders): macOS asking on the Mac's
// screen (with the machine's screen one tap away), allowed, or refused (with
// where to allow it again).
import { MacFolderAccess, type MacFolder } from "@achoo254/chat-proto/remote/remote";
import { useState } from "react";
import { DialogHead, Modal, useDomId } from "../messaging/ui/parts.tsx";
import { Link, paths } from "../router.tsx";
import { ScreenViewHost } from "./browser/takeover-card.tsx";
import { MachineIcon } from "./machine-icons.tsx";
import type { LinkState, MachineLink } from "./link/machine-link.ts";
import { mcpAiName } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

/** `~/Documents` for a folder in the home folder, the path itself otherwise. */
export function folderLabel(folder: string, home: string): string {
	return home !== "" && folder.startsWith(`${home}/`) ? `~${folder.slice(home.length)}` : folder;
}

/** The access the machine last reported for `folder`; NOT_ASKED when it named none. */
export function folderAccess(state: LinkState, folder: string): MacFolderAccess {
	return state.info?.macFolders.find((f) => f.path === folder)?.access ?? MacFolderAccess.NOT_ASKED;
}

export function MacFolderAccessDialog({ link, state }: { link: Pick<MachineLink, "request" | "dismissMacFolderAsk">; state: LinkState }) {
	const t = useMachinesCopy();
	const c = t.macFolder;
	const id = useDomId("mac-folder");
	// From the tap until the machine's next info, which carries its answer: the request is on its way.
	const [sending, setSending] = useState(false);
	const [waitingFrom, setWaitingFrom] = useState<LinkState["info"] | undefined>(undefined);
	const [failed, setFailed] = useState(false);
	const [screen, setScreen] = useState(false);
	if (waitingFrom !== undefined && state.info !== waitingFrom) setWaitingFrom(undefined);
	const folder = state.macFolderAsk;
	if (folder === null) return null;
	const online = state.status.kind === "open";
	const name = folderLabel(folder, state.info?.home ?? "");
	const access = folderAccess(state, folder);
	const close = () => {
		setFailed(false);
		link.dismissMacFolderAsk();
	};
	const ask = () => {
		setSending(true);
		setFailed(false);
		link.request({ case: "macFolderAccessAsk", value: { path: folder } }).then(
			() => {
				setSending(false);
				setWaitingFrom(state.info);
			},
			() => {
				setSending(false);
				setFailed(true);
			},
		);
	};
	if (screen) return <ScreenViewHost link={link as MachineLink} ai={mcpAiName(state.info)} online={online} inSession={false} onClose={() => setScreen(false)} />;
	const asking = access === MacFolderAccess.ASKING || sending || waitingFrom !== undefined;
	return (
		<Modal labelledBy={id} onClose={close}>
			<DialogHead id={id} title={c.title(name)} onClose={close} />
			<div className="dlg-body stack" data-id="mac-folder" data-access={MacFolderAccess[access]}>
				{access === MacFolderAccess.GRANTED ? (
					<p role="status" data-id="mac-folder-granted">
						{c.granted(name)}
					</p>
				) : access === MacFolderAccess.DENIED && !asking ? (
					<p className="mx-warn" data-id="mac-folder-denied">
						{c.denied(name)}
					</p>
				) : asking ? (
					<p role="status" data-id="mac-folder-asking">
						{c.asking}
					</p>
				) : (
					<>
						<p>{c.why(name)}</p>
						<p>{c.how}</p>
						<p className="note">{c.scope}</p>
					</>
				)}
				{failed && (
					<p className="mx-error" role="alert">
						{c.askFailed}
					</p>
				)}
			</div>
			<div className="dlg-foot">
				{access === MacFolderAccess.GRANTED ? (
					<button type="button" className="btn btn-primary" onClick={close} data-id="mac-folder-done">
						{c.close}
					</button>
				) : (
					<>
						<button type="button" className="btn" onClick={close}>
							{asking ? c.close : c.later}
						</button>
						{asking && state.info?.screenShare === true && (
							<button type="button" className="btn" disabled={!online} onClick={() => setScreen(true)} data-id="mac-folder-screen">
								{c.openScreen}
							</button>
						)}
						{!asking && (
							<button type="button" className="btn btn-primary" disabled={!online} onClick={ask} data-id="mac-folder-ask">
								{access === MacFolderAccess.DENIED ? c.retry : c.ask}
							</button>
						)}
					</>
				)}
			</div>
		</Modal>
	);
}

/** How a folder is named in the list: iCloud Drive by its name, the rest as `folderLabel`. */
export function folderName(folder: string, home: string, icloud: string): string {
	return home !== "" && folder === `${home}/Library/Mobile Documents` ? icloud : folderLabel(folder, home);
}

/**
 * The machine's page: every folder macOS protects with tunelo's access to it,
 * and asking for one before any work needs it (a terminal's commands, or a
 * path a command reads from a variable, are never stopped to ask). Asking
 * opens the same question as a refused task (MacFolderAccessDialog).
 */
export function MacFoldersCard({ link, state }: { link: Pick<MachineLink, "showMacFolderAsk">; state: LinkState }) {
	const c = useMachinesCopy().macFolder;
	const folders = state.info?.macFolders ?? [];
	if (folders.length === 0) return null;
	const home = state.info?.home ?? "";
	const online = state.status.kind === "open";
	const label = (access: MacFolderAccess): string => {
		if (access === MacFolderAccess.GRANTED) return c.access.granted;
		if (access === MacFolderAccess.ASKING) return c.access.asking;
		if (access === MacFolderAccess.DENIED) return c.access.denied;
		return c.access.notAsked;
	};
	return (
		<section className="card pad mx-card" id="mac-folders" data-id="machine-mac-folders">
			<h3>{c.listTitle}</h3>
			<p className="note">{c.listNote}</p>
			<ul className="mx-mac-folders">
				{folders.map((f) => (
					<li key={f.path} data-id="mac-folder-row" data-access={MacFolderAccess[f.access]}>
						<span className="mx-mac-folder-name">
							<span>{folderName(f.path, home, c.icloud)}</span>
							<span className="mono muted">{folderLabel(f.path, home)}</span>
						</span>
						<span className={`chip mx-chip ${f.access === MacFolderAccess.GRANTED ? "ok" : f.access === MacFolderAccess.DENIED ? "warn" : ""}`}>{label(f.access)}</span>
						{f.access !== MacFolderAccess.GRANTED && (
							<button type="button" className="btn btn-sm" disabled={!online} onClick={() => link.showMacFolderAsk(f.path)} data-id="mac-folder-row-ask">
								{f.access === MacFolderAccess.DENIED ? c.retry : c.ask}
							</button>
						)}
					</li>
				))}
			</ul>
		</section>
	);
}

/**
 * The folders macOS let tunelo into since `since` was taken (the moment a
 * terminal opened): that terminal's processes were started in a sandbox
 * still keeping them out (agent safety/mac-sandbox.ts) and reach them only
 * once opened again.
 */
export function grantedSince(since: readonly MacFolder[], now: readonly MacFolder[]): string[] {
	const before = new Set(since.filter((f) => f.access === MacFolderAccess.GRANTED).map((f) => f.path));
	return now.filter((f) => f.access === MacFolderAccess.GRANTED && !before.has(f.path)).map((f) => f.path);
}

/**
 * In a session's terminal: a folder macOS let tunelo into after this view
 * opened is still out of the terminal's reach until it is opened again (its
 * sandbox was set when it started), so this says so, with the machine's
 * folder list one tap away.
 */
export function TerminalFolderNotice({ machine, state }: { machine: string; state: LinkState }) {
	const c = useMachinesCopy().macFolder;
	const [since, setSince] = useState<readonly MacFolder[] | null>(state.info?.macFolders ?? null);
	const [hidden, setHidden] = useState<string>("");
	if (since === null && state.info !== null) setSince(state.info.macFolders);
	const fresh = since === null ? [] : grantedSince(since, state.info?.macFolders ?? []);
	const home = state.info?.home ?? "";
	const names = fresh.map((f) => folderName(f, home, c.icloud)).join(", ");
	if (fresh.length === 0 || hidden === fresh.join("\n")) return null;
	return (
		<section className="mx-limit" role="status" data-id="terminal-folder-reopen">
			<div className="mx-limit-inner">
				<MachineIcon name="terminal" />
				<p>{c.terminalReopen(names)}</p>
				<div className="mx-limit-acts">
					<Link to={paths.machineInfo(machine)} className="btn btn-sm mx-btn-ghost">
						{c.manage}
					</Link>
					<button type="button" className="btn btn-sm mx-btn-ghost" onClick={() => setHidden(fresh.join("\n"))}>
						{c.dismiss}
					</button>
				</div>
			</div>
		</section>
	);
}
