// On a machine's page (tunelo 2.0.12+): the browser tunelo keeps for Claude,
// whether it runs, and "Xem trình duyệt của máy" to view and control it
// from here while it runs.
import { useState } from "react";
import { ConfirmDialog } from "../../messaging/bots/dialogs.tsx";
import type { LinkState, MachineLink } from "../link/machine-link.ts";
import { MachineIcon } from "../machine-icons.tsx";
import { errorText } from "../use-machines.ts";
import { useMachinesCopy } from "../use-machines-copy.ts";
import { BrowserViewHost, openMachineBrowser } from "./takeover-card.tsx";

interface MachineBrowserProps {
	link: MachineLink;
	state: LinkState;
	ai: string;
}

export function MachineBrowser({ link, state, ai }: MachineBrowserProps) {
	const t = useMachinesCopy();
	const b = t.browser;
	const [viewing, setViewing] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [confirming, setConfirming] = useState(false);
	const [clearing, setClearing] = useState(false);
	const [cleared, setCleared] = useState(false);
	const online = state.status.kind === "open";
	const running = state.info?.browser?.running === true;
	const takeover = viewing === null ? undefined : state.takeovers.get(viewing);

	const open = () => {
		setBusy(true);
		setError("");
		openMachineBrowser(link).then(
			(opened) => {
				setBusy(false);
				if (opened !== null) setViewing(opened.takeoverId);
			},
			(err: unknown) => {
				setBusy(false);
				setError(errorText(t, err, ai));
			},
		);
	};

	/** Deletes the profile on the machine (as `tunelo browser clear`); the machine answers with its info. */
	const clear = () => {
		setClearing(true);
		setError("");
		link.request({ case: "browserClear", value: {} }).then(
			() => {
				setClearing(false);
				setConfirming(false);
				setViewing(null);
				setCleared(true);
			},
			(err: unknown) => {
				setClearing(false);
				setConfirming(false);
				setError(errorText(t, err, ai));
			},
		);
	};

	return (
		<section className="card pad mx-card" data-id="machine-browser">
			<h3>{b.machineTitle}</h3>
			<p className="note">{b.machineNote}</p>
			{running ? (
				<div>
					<button type="button" className="btn btn-sm" disabled={!online || busy} onClick={open} data-id="machine-browser-open">
						<MachineIcon name="monitor" small />
						{b.machineOpen}
					</button>
				</div>
			) : (
				<p className="muted">{b.machineIdle}</p>
			)}
			{state.info?.browser?.clearable === true && (
				<div>
					<button type="button" className="btn btn-sm danger-outline" disabled={!online} onClick={() => setConfirming(true)} data-id="machine-browser-clear">
						{b.clear}
					</button>
				</div>
			)}
			{cleared && (
				<p className="muted" role="status">
					{b.cleared}
				</p>
			)}
			{confirming && (
				<ConfirmDialog
					title={b.clearTitle}
					body={<p>{b.clearBody}</p>}
					action={b.clear}
					busyLabel={b.clearing}
					busy={clearing}
					danger
					onConfirm={clear}
					onClose={() => setConfirming(false)}
				/>
			)}
			{error !== "" && (
				<p className="mx-error" role="alert">
					{error}
				</p>
			)}
			{takeover !== undefined && <BrowserViewHost link={link} takeover={takeover} ai={ai} online={online} inSession={false} onMinimize={() => setViewing(null)} />}
		</section>
	);
}
