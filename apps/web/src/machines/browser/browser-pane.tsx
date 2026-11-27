// The machine's browser as a tab of the dock (tunelo 3.27.0+): asks the machine to open it (it starts
// when it does not run), then shows its live view embedded. The machine keeps one browser for all
// devices, with its own tabs inside. Closing this dock tab (terminal-dock.tsx), or the browser's last
// tab, closes the browser on the machine with every process of it, unless the AI waits on the user in
// it; its sign-ins stay in the profile. When the browser closes on the machine the pane says so and
// offers to open it again (it never restarts one the user just closed by itself).
import { useEffect, useState, useSyncExternalStore } from "react";
import type { MachineLink } from "../link/machine-link.ts";
import { errorText } from "../use-machines.ts";
import { useMachinesCopy } from "../use-machines-copy.ts";
import { BrowserViewHost, openBrowserTab } from "./takeover-card.tsx";

interface BrowserPaneProps {
	link: MachineLink;
	/** The machine's link is open. */
	online: boolean;
	/** The dock shows this tab now (a hidden tab stops streaming). */
	active: boolean;
}

export function BrowserPane({ link, online, active }: BrowserPaneProps) {
	const t = useMachinesCopy();
	const b = t.browser;
	const state = useSyncExternalStore(link.subscribe, link.snapshot);
	const [takeoverId, setTakeoverId] = useState<string | null>(null);
	const [opening, setOpening] = useState(online);
	const [error, setError] = useState("");
	// The link opening (or dropping) starts over: the machine is asked again below, so nothing is "ended" meanwhile.
	const [wasOnline, setWasOnline] = useState(online);
	if (wasOnline !== online) {
		setWasOnline(online);
		setOpening(online);
		setError("");
	}
	/** Raised by "Mở lại": the browser is asked for again though the link did not change. */
	const [attempt, setAttempt] = useState(0);
	const takeover = takeoverId === null ? undefined : state.takeovers.get(takeoverId);

	// Asked for whenever the link opens (the first time, and after every reconnect, which forgets takeovers):
	// the machine answers with the one that is open, or starts the browser.
	useEffect(() => {
		if (!online) return;
		let live = true;
		openBrowserTab(link).then(
			(opened) => {
				if (!live) return;
				setOpening(false);
				if (opened !== null) setTakeoverId(opened.takeoverId);
			},
			(err: unknown) => {
				if (!live) return;
				setOpening(false);
				setError(errorText(t, err, ""));
			},
		);
		return () => {
			live = false;
		};
	}, [link, online, attempt, t]);

	const reopen = () => {
		setOpening(true);
		setError("");
		setAttempt((n) => n + 1);
	};

	if (takeover !== undefined) return <BrowserViewHost link={link} takeover={takeover} ai="" online={online} inSession={false} onMinimize={() => undefined} embedded active={active} />;
	const ended = online && takeoverId !== null && !opening && error === "";
	return (
		<div className="mx-browser embedded mx-browser-idle" data-id="browser-pane-idle">
			{error !== "" ? (
				<p className="mx-error" role="alert">
					{error}
				</p>
			) : (
				<p className="muted" role="status">
					{ended ? b.ended : b.opening}
				</p>
			)}
			{(ended || error !== "") && online && (
				<button type="button" className="btn btn-primary btn-sm" onClick={reopen} data-id="browser-pane-reopen">
					{b.reopen}
				</button>
			)}
		</div>
	);
}
