// The plain shells running on a machine, on its board ("Tổng quan máy"): a
// shell opened from the machines list keeps running after its page is left,
// and a shell in the home folder sits under no workspace of the AI Agent
// column, so without this the board would say nothing runs while one does.
// Each row opens its shell again; stopping them stays on the machine's
// settings ("Terminal đang chạy trên máy"), linked under the list. The list
// is asked when the board opens and every 30 seconds while it is in front.
import { useEffect, useState } from "react";
import type { TermSessionInfo } from "@achoo254/chat-proto/remote/remote";
import { Link, paths } from "../router.tsx";
import { openedTime } from "../terminal/new-tab-actions.ts";
import { aiPaths } from "./ai-paths.ts";
import type { MachineLink } from "./link/machine-link.ts";
import { termState } from "./machine-terminal-sessions.tsx";
import { MachineIcon } from "./machine-icons.tsx";
import { folderName } from "./new-session-hints.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

const RELIST_MS = 30_000;

/** The machine's live plain shells, newest first (an AI's own CLI is its session's tile already); null until listed. */
export function useBoardShells(link: Pick<MachineLink, "request"> | null, listable: boolean): readonly TermSessionInfo[] | null {
	const [shells, setShells] = useState<readonly TermSessionInfo[] | null>(null);
	useEffect(() => {
		if (link === null || !listable) return;
		let live = true;
		const ask = () => {
			link.request({ case: "termListRequest", value: {} }).then(
				(frame) => {
					if (!live || frame.body.case !== "termListResult") return;
					const list = frame.body.value.sessions.filter((s) => s.threadId === "" && !s.exited);
					setShells(list.sort((a, b) => Number(b.createdAt - a.createdAt)));
				},
				// A failed ask keeps the list shown.
				() => undefined,
			);
		};
		ask();
		const timer = window.setInterval(() => {
			if (document.visibilityState === "visible") ask();
		}, RELIST_MS);
		return () => {
			live = false;
			window.clearInterval(timer);
		};
	}, [link, listable]);
	// Not listable now (offline, no terminal): the last list would be stale.
	return listable ? shells : null;
}

/** "Terminal đang chạy (n)": each shell with where it runs and whether a device shows it, and "Mở". */
export function BoardShells({ machine, shells, now }: { machine: string; shells: readonly TermSessionInfo[]; now: number }) {
	const t = useMachinesCopy();
	const tt = t.terminal;
	const m = tt.manage;
	if (shells.length === 0) return null;
	return (
		<>
			<h3 className="mx-section">{t.board.shells(shells.length)}</h3>
			<ul className="mx-terms-list" data-id="board-shells">
				{shells.map((s) => {
					const state = termState(s);
					const title = s.title || tt.shellSession;
					const facts = [s.cwd === "" ? "" : folderName(s.cwd), s.createdAt > 0n ? tt.openedAt(openedTime(Number(s.createdAt), now)) : ""].filter((x) => x !== "").join(" · ");
					return (
						<li key={s.session} className="mx-term" data-state={state} data-id={`board-shell-${s.session}`}>
							<span className="mx-term-icon" aria-hidden="true">
								<MachineIcon name="terminal" small />
							</span>
							<span className="mx-term-text">
								<b title={title}>{title}</b>
								{facts !== "" && <small title={s.cwd}>{facts}</small>}
							</span>
							<span className={`chip mx-chip mx-term-chip ${state}`} title={state === "viewed" ? m.viewedHint : m.idleHint}>
								{state === "viewed" ? m.viewed : m.idle}
							</span>
							<span className="mx-term-acts">
								<Link to={aiPaths.showSession(machine, s.session)} className="btn btn-sm" aria-label={`${m.open} ${title}`}>
									<MachineIcon name="terminal" small />
									{m.open}
								</Link>
							</span>
						</li>
					);
				})}
			</ul>
			<Link to={paths.machineInfo(machine)} className="mx-board-more" data-id="board-shells-manage">
				{t.board.manageShells}
			</Link>
		</>
	);
}
