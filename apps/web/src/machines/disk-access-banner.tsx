// A Mac whose tunelo lacks Full Disk Access: sessions in the protected folders
// are blocked, or hang on a macOS prompt nobody at the machine answers. Only
// the owner can grant it, on the machine; this shows how, can open the setting
// on the machine's screen again, and says so once the machine reports it granted
// (it checks by itself every few seconds). It says why the permission is asked
// for, what happens without it, and that only those folders need it, so the
// owner can decide. On a page it is a card in the page's column, the steps
// behind "Hướng dẫn" (open the first time, folded after); in a session it is
// one line, so the terminal or the chat keeps the room. "Granted" is one green
// line that hides itself after a few seconds (or on "Ẩn"), remembered per
// machine.
import type { MachineInfo } from "@achoo254/chat-proto/remote/remote";
import { useEffect, useState } from "react";
import { DiskAccessGuide } from "./disk-access-guide.tsx";
import { Icon } from "../components/screen-icons.tsx";
import type { MachineLink } from "./link/machine-link.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

type Reopen = "idle" | "sending" | "done" | "failed";

const SEEN_KEY = "ai:disk-access-guide-seen";
const GRANTED_KEY = (machine: string) => `ai:disk-access-granted-seen:${machine}`;
/** How long "granted" shows before it hides itself. */
export const GRANTED_SHOWN_MS = 6_000;

function stored(key: string): boolean {
	try {
		return window.localStorage.getItem(key) === "1";
	} catch {
		return false;
	}
}

function store(key: string, on: boolean): void {
	try {
		if (on) window.localStorage.setItem(key, "1");
		else window.localStorage.removeItem(key);
	} catch {
		// Storage off: this page still behaves the same.
	}
}

interface BannerProps {
	link: Pick<MachineLink, "request">;
	info: MachineInfo | null;
	online: boolean;
	/** The machine's id, to remember a "granted" already seen. */
	machine: string;
	/** One line, in a session. */
	bar?: boolean;
}

export function DiskAccessBanner({ link, info, online, machine, bar = false }: BannerProps) {
	const t = useMachinesCopy();
	const needed = info?.needsFullDiskAccess === true;
	const [wasNeeded, setWasNeeded] = useState(false);
	const [reopen, setReopen] = useState<Reopen>("idle");
	const [open, setOpen] = useState(() => !bar && !stored(SEEN_KEY));
	const [grantedHidden, setGrantedHidden] = useState(() => stored(GRANTED_KEY(machine)));
	// Remembered while rendering (no effect): "granted" only follows "needed" seen here.
	if (needed && !wasNeeded) setWasNeeded(true);
	// Missing again: the next grant shows once more.
	if (needed && grantedHidden) setGrantedHidden(false);
	const granted = !needed && wasNeeded && info !== null && !grantedHidden;

	useEffect(() => {
		if (needed) {
			store(GRANTED_KEY(machine), false);
			if (!bar) store(SEEN_KEY, true);
		}
	}, [needed, bar, machine]);
	useEffect(() => {
		if (!granted) return;
		const timer = window.setTimeout(() => {
			setGrantedHidden(true);
			store(GRANTED_KEY(machine), true);
		}, GRANTED_SHOWN_MS);
		return () => window.clearTimeout(timer);
	}, [granted, machine]);

	function hideGranted(): void {
		setGrantedHidden(true);
		store(GRANTED_KEY(machine), true);
	}

	if (!needed) {
		return granted ? (
			<div className={bar ? "mx-strip mx-disk-ok" : "mx-disk-access mx-disk-ok"} role="status" data-id="disk-access-granted">
				<Icon name="check" small />
				<span className="grow">{t.diskAccess.granted}</span>
				<button type="button" className="btn btn-sm" onClick={hideGranted}>
					{t.diskAccess.dismiss}
				</button>
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
	const why = (
		<ul className="mx-disk-why">
			<li>{t.diskAccess.why}</li>
			<li>{t.diskAccess.without}</li>
			<li>{t.diskAccess.optional}</li>
		</ul>
	);
	return (
		<div className={bar ? "mx-strip warn mx-disk-bar" : "mx-disk-access"} role="alert" data-id="disk-access">
			<div className="mx-disk-line">
				<Icon name="alert" small />
				<b className="grow">{t.diskAccess.title}</b>
				<button type="button" className="btn btn-sm" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-id="disk-access-guide">
					{t.diskAccess.guide}
				</button>
			</div>
			{!bar && why}
			{open && (
				<div className="mx-disk-more">
					{bar && why}
					<DiskAccessGuide binary={info.agentBinary} home={info.home} />
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
