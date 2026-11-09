// A Mac whose tunelo lacks Full Disk Access: sessions in the protected folders
// are blocked, or hang on a macOS prompt nobody at the machine answers. Only
// the owner can grant it, on the machine; this shows how, can open the setting
// on the machine's screen again, and says so once the machine reports it granted
// (it checks by itself every few seconds).
import type { MachineInfo } from "@achoo254/chat-proto/remote/remote";
import { useState } from "react";
import { Icon } from "../components/screen-icons.tsx";
import { DiskAccessGuide } from "./disk-access-guide.tsx";
import type { MachineLink } from "./link/machine-link.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

type Reopen = "idle" | "sending" | "done" | "failed";

export function DiskAccessBanner({ link, info, online }: { link: Pick<MachineLink, "request">; info: MachineInfo | null; online: boolean }) {
	const t = useMachinesCopy();
	const needed = info?.needsFullDiskAccess === true;
	const [wasNeeded, setWasNeeded] = useState(false);
	const [reopen, setReopen] = useState<Reopen>("idle");
	// Remembered while rendering (no effect): "granted" only follows "needed" seen here.
	if (needed && !wasNeeded) setWasNeeded(true);

	if (!needed) {
		// Granted while this page showed the steps (info is null while reconnecting).
		return wasNeeded && info !== null ? (
			<div className="mx-strip ok" role="status" data-id="disk-access-granted">
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
	return (
		<div className="mx-strip warn mx-disk-access" role="alert" data-id="disk-access">
			<Icon name="alert" small />
			<div className="grow">
				<b>{t.diskAccess.title}</b>
				<p>{t.diskAccess.body}</p>
				<DiskAccessGuide />
				<div className="mx-disk-actions">
					<button type="button" className="btn btn-sm" data-id="disk-access-reopen" disabled={!online || reopen === "sending"} onClick={openOnMachine}>
						{t.diskAccess.reopen}
					</button>
					{reopen === "done" && <span role="status">{t.diskAccess.reopened}</span>}
					{reopen === "failed" && <span role="status">{t.diskAccess.reopenFailed}</span>}
				</div>
			</div>
		</div>
	);
}
