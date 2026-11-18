// A folder macOS protects (tunelo 3.17.0+). tunelo keeps only the
// permissions macOS gives any program, as Claude Code in Terminal does, and
// never asks for Full Disk Access: it stays out of Desktop, Documents,
// Downloads, iCloud Drive, cloud providers' folders and other volumes until
// the user agrees here. When the machine refuses work in one, this asks
// whether tunelo may ask macOS for that folder; once agreed, it follows the
// machine's answer (MachineInfo.mac_folders): macOS asking on the Mac's
// screen (with the machine's screen one tap away), allowed, or refused (with
// where to allow it again).
import { MacFolderAccess } from "@achoo254/chat-proto/remote/remote";
import { useState } from "react";
import { DialogHead, Modal, useDomId } from "../messaging/ui/parts.tsx";
import { ScreenViewHost } from "./browser/takeover-card.tsx";
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
