// The machines' plain shells in the AI Agent column, as Orca lists a
// worktree's terminals under it: each live shell (TermListResult, threadId
// empty) sits under the workspace of its machine whose folder holds it most
// closely (the folder itself, else the deepest parent). A shell outside every
// workspace stays on the machine's page ("Terminal đang chạy trên máy"); an AI's
// own CLI is its session's row already. The lists are asked of every online
// machine with a terminal: when the column shows, on every page change (a
// shell opened or closed in the dock) and every 30 seconds while visible.
// A row opens the shell in the machine's terminal page (?open=<session>).
import { useEffect, useState } from "react";
import type { TermSessionInfo } from "@achoo254/chat-proto/remote/remote";
import { followInApp, usePathname } from "../router.tsx";
import { terminalGate } from "./agent-version.ts";
import type { AgentProject } from "./agent-projects-client.ts";
import { aiPaths } from "./ai-paths.ts";
import { MachineIcon } from "./machine-icons.tsx";
import { folderName } from "./new-session-hints.ts";
import { timeAgo, type MachineView } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

const RELIST_MS = 30_000;

/** Live shells by workspace id. */
export type ShellsByWorkspace = ReadonlyMap<number, readonly TermSessionInfo[]>;

/** A folder to compare: one kind of separator, no trailing one, case folded on Windows. */
function folderKey(dir: string, windows: boolean): string {
	const unified = dir.replace(/\\/g, "/").replace(/\/+$/, "");
	return windows ? unified.toLowerCase() : unified;
}

/** Each live shell of one machine under the workspace whose folder holds it most closely; newest first. */
export function placeShells(workspaces: readonly { readonly id: number; readonly dir: string }[], sessions: readonly TermSessionInfo[], windows: boolean): Map<number, TermSessionInfo[]> {
	const placed = new Map<number, TermSessionInfo[]>();
	const shells = sessions.filter((s) => s.threadId === "" && !s.exited && s.cwd !== "").sort((a, b) => Number(b.createdAt - a.createdAt));
	for (const shell of shells) {
		const cwd = folderKey(shell.cwd, windows);
		let best: { id: number; length: number } | null = null;
		for (const w of workspaces) {
			const dir = folderKey(w.dir, windows);
			const holds = cwd === dir || cwd.startsWith(`${dir}/`);
			if (holds && (best === null || dir.length > best.length)) best = { id: w.id, length: dir.length };
		}
		if (best === null) continue;
		placed.set(best.id, [...(placed.get(best.id) ?? []), shell]);
	}
	return placed;
}

/** The machines that can list their terminal sessions now. */
function listable(machines: readonly MachineView[]): MachineView[] {
	return machines.filter((m) => m.conn.kind === "on" && terminalGate(m.state.info) === "available");
}

/** Every listable machine's shells, placed under the projects' workspaces on it. */
export function useSidebarShells(machines: readonly MachineView[], projects: readonly AgentProject[]): ShellsByWorkspace {
	const pathname = usePathname();
	const [lists, setLists] = useState<ReadonlyMap<string, readonly TermSessionInfo[]>>(new Map());
	const hosts = listable(machines);
	const hostsKey = hosts.map((m) => m.entry.ref).join(",");

	useEffect(() => {
		let live = true;
		const ask = () => {
			for (const m of hosts) {
				m.link.request({ case: "termListRequest", value: {} }).then(
					(frame) => {
						if (!live || frame.body.case !== "termListResult") return;
						const sessions = frame.body.value.sessions;
						setLists((prev) => new Map(prev).set(m.entry.ref, sessions));
					},
					// A failed ask keeps the list shown.
					() => undefined,
				);
			}
		};
		ask();
		const timer = window.setInterval(() => {
			if (document.visibilityState === "visible") ask();
		}, RELIST_MS);
		return () => {
			live = false;
			window.clearInterval(timer);
		};
		// `hostsKey` stands for `hosts`; a page change asks again (the dock opened or closed a shell).
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [hostsKey, pathname]);

	const placed = new Map<number, TermSessionInfo[]>();
	for (const m of hosts) {
		const sessions = lists.get(m.entry.ref);
		if (sessions === undefined) continue;
		const workspaces = projects.flatMap((p) => p.workspaces).filter((w) => w.machineId === m.entry.id);
		for (const [id, shells] of placeShells(workspaces, sessions, m.entry.os === "win32")) placed.set(id, shells);
	}
	return placed;
}

/** The shells under a workspace's sessions: name, where in the folder, and whether a device shows it. */
export function ShellRows({ machine, dir, shells, now }: { machine: MachineView; dir: string; shells: readonly TermSessionInfo[]; now: number }) {
	const t = useMachinesCopy();
	const m = t.terminal.manage;
	if (shells.length === 0) return null;
	return (
		<ul className="mx-rows mx-shells" aria-label={t.agent.projects.shells(folderName(dir))}>
			{shells.map((s) => {
				const path = aiPaths.showSession(machine.entry.ref, s.session);
				const name = s.title || t.terminal.shellSession;
				// A shell in a subfolder names it ("apps/web"), one in the workspace's own folder needs nothing more.
				const sub = s.cwd.replace(/\\/g, "/").slice(dir.replace(/\\/g, "/").replace(/\/+$/, "").length + 1);
				const line = [s.attached ? m.viewed : m.idle, sub].filter((x) => x !== "").join(" · ");
				return (
					<li key={s.session}>
						<a href={path} className="mx-srow slim mx-shell" data-row="" data-id={`sidebar-shell-${s.session}`} title={s.attached ? m.viewedHint : m.idleHint} onClick={(event) => followInApp(event, path)}>
							<span className="tx">
								<span className="line">
									<span className="mx-glyph" aria-hidden="true">
										<MachineIcon name="terminal" small />
									</span>
									<span className="name">{name}</span>
									{s.createdAt > 0n && <time>{timeAgo(t, Number(s.createdAt), now)}</time>}
								</span>
								<span className="line">
									<span className="mx-shell-sub">{line}</span>
								</span>
							</span>
						</a>
					</li>
				);
			})}
		</ul>
	);
}
