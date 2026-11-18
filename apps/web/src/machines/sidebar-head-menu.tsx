// The "⋯" menu in the AI Agent column's head: the actions that are not the
// next step of a new user. "Làm mới danh sách" lists the machines, the
// projects and each reachable machine's sessions and folders again, for a
// column that looks stale without reloading the app; "Quản lý máy" opens the
// machines. A dot on the button when a machine needs the user (blocked on
// this device, or a tunelo too old to talk to), so the menu hides nothing urgent.
import { useState } from "react";
import { Icon } from "../components/screen-icons.tsx";
import { Link } from "../router.tsx";
import { aiPaths } from "./ai-paths.ts";
import { MachineIcon } from "./machine-icons.tsx";
import { projectsSupported } from "./projects-view.ts";
import { useHub, type MachineView } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";
import { usePopover } from "./use-popover.ts";

export function HeadMenu({ machines, refreshProjects, hostNote, attention, manageCurrent }: { machines: readonly MachineView[]; refreshProjects: () => Promise<void>; hostNote: string; attention: number; manageCurrent: boolean }) {
	const t = useMachinesCopy();
	const hub = useHub();
	const { open, setOpen, ref } = usePopover();
	const [busy, setBusy] = useState(false);
	const refresh = () => {
		setBusy(true);
		const online = machines.filter((m) => m.conn.kind === "on");
		Promise.allSettled([
			hub.refresh(),
			refreshProjects(),
			...online.map((m) => m.link.request({ case: "threadList", value: { advisor: true } })),
			...online.filter((m) => projectsSupported(m.state.info?.agentVersion)).map((m) => m.link.request({ case: "projectList", value: {} })),
		]).finally(() => setBusy(false));
	};
	const label = hostNote === "" ? t.agent.steps.more : `${t.agent.steps.more}: ${hostNote}`;
	return (
		<span className="mx-row-menu mx-head-menu" ref={ref}>
			<button type="button" className="icon-btn" data-id="sidebar-more" aria-label={label} title={label} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
				{busy ? <span className="spin" aria-hidden="true" /> : <Icon name="dots" small />}
				{attention > 0 && <span className="mx-head-dot" aria-hidden="true" />}
			</button>
			{open && (
				<div className="mx-menu">
					<button type="button" data-id="sidebar-refresh" disabled={busy} onClick={refresh}>
						<Icon name="refresh" small />
						<span>{t.sessions.refresh}</span>
					</button>
					<Link to={aiPaths.manage} className="mx-menu-link" data-id="sidebar-manage" current={manageCurrent} onNavigate={() => setOpen(false)}>
						<MachineIcon name="monitor" small />
						<span>{t.agent.machines}</span>
						{attention > 0 && (
							<span className="mx-manage-count" role="img" aria-label={hostNote} data-id="machines-need-you">
								{attention}
							</span>
						)}
					</Link>
				</div>
			)}
		</span>
	);
}
