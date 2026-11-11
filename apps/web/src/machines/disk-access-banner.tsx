// A Mac whose tunelo lacks Full Disk Access: sessions in the protected folders
// are blocked, or hang on a macOS prompt nobody at the machine answers. Only
// the owner can grant it, on the machine; this shows how, can open the setting
// on the machine's screen again, and says so once the machine reports it granted
// (it checks by itself every few seconds). On a page it is a card in the
// page's column, its steps behind "Hướng dẫn" (open the first time, folded
// after); in a session it is one line, so the terminal or the chat keeps the
// room.
import type { MachineInfo } from "@achoo254/chat-proto/remote/remote";
import { useEffect, useState } from "react";
import { DiskAccessGuide } from "./disk-access-guide.tsx";
import { Icon } from "../components/screen-icons.tsx";
import type { MachineLink } from "./link/machine-link.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

type Reopen = "idle" | "sending" | "done" | "failed";

const SEEN_KEY = "ai:disk-access-guide-seen";

/** The steps open by themselves only the first time this device shows them. */
function guideSeen(): boolean {
	try {
		return window.localStorage.getItem(SEEN_KEY) === "1";
	} catch {
		return false;
	}
}

export function DiskAccessBanner({ link, info, online, bar = false }: { link: Pick<MachineLink, "request">; info: MachineInfo | null; online: boolean; bar?: boolean }) {
	const t = useMachinesCopy();
	const needed = info?.needsFullDiskAccess === true;
	const [wasNeeded, setWasNeeded] = useState(false);
	const [reopen, setReopen] = useState<Reopen>("idle");
	const [open, setOpen] = useState(() => !bar && !guideSeen());
	useEffect(() => {
		if (bar || !needed) return;
		try {
			window.localStorage.setItem(SEEN_KEY, "1");
		} catch {
			// Storage off: the steps open again next time.
		}
	}, [bar, needed]);
	// Remembered while rendering (no effect): "granted" only follows "needed" seen here.
	if (needed && !wasNeeded) setWasNeeded(true);

	if (!needed) {
		// Granted while this page showed the steps (info is null while reconnecting).
		return wasNeeded && info !== null ? (
			<div className={bar ? "mx-strip ok" : "mx-disk-access ok"} role="status" data-id="disk-access-granted">
				<Icon name="check" small />
				{t.diskAccess.granted}
			</div>
		) : null;
	}

	const openOnMachine = () => {
		setReopen("sending");
		link.request({ case: "openDiskAccessSettings", value: {} }).then(
			() => setReopen("done"),
			() => setReopen("failed"),
		);
	};
	const toggle = (
		<button type="button" className="btn btn-sm" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-id="disk-access-guide">
			{t.diskAccess.guide}
		</button>
	);
	return (
		<div className={bar ? "mx-strip warn mx-disk-bar" : "mx-disk-access"} role="alert" data-id="disk-access">
			<div className="mx-disk-line">
				<Icon name="alert" small />
				<b className="grow">{t.diskAccess.title}</b>
				{toggle}
			</div>
			{!bar && <p>{t.diskAccess.body}</p>}
			{open && (
				<div className="mx-disk-more">
					{bar && <p>{t.diskAccess.body}</p>}
					<DiskAccessGuide />
				</div>
			)}
			{(open || !bar) && (
				<div className="mx-disk-actions">
					<button type="button" className="btn btn-sm" data-id="disk-access-reopen" disabled={!online || reopen === "sending"} onClick={openOnMachine}>
						{t.diskAccess.reopen}
					</button>
					{reopen === "done" && <span role="status">{t.diskAccess.reopened}</span>}
					{reopen === "failed" && <span role="status">{t.diskAccess.reopenFailed}</span>}
				</div>
			)}
		</div>
	);
}
