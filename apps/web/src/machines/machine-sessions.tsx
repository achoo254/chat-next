// The list column inside a machine: a button back to the machines, "Phiên
// mới", the filters (all, needs you, running), the sessions with those that
// need the user on top, and the machine's capacity at the bottom.
import { useState } from "react";
import { ThreadState } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../components/screen-icons.tsx";
import { Link, paths } from "../router.tsx";
import { sortForList } from "./link/machine-link.ts";
import { MachineIcon } from "./machine-icons.tsx";
import { NewSession } from "./new-session.tsx";
import { aiName, folderName, stateKey, timeAgo, useEntry, useHub, useLink, useNow } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

type Filter = "all" | "need" | "running";

export function SessionList({ machine, current }: { machine: string; current: string | null }) {
	const t = useMachinesCopy();
	const hub = useHub();
	const entry = useEntry(hub, machine);
	const [link, state] = useLink(hub, machine);
	const now = useNow();
	const [filter, setFilter] = useState<Filter>("all");
	const [creating, setCreating] = useState(false);
	const name = entry?.name ?? "";
	const online = state.status.kind === "open";
	const need = state.threads.filter((x) => x.state === ThreadState.WAITING).length;
	const shown = sortForList(state.threads).filter((x) =>
		filter === "need" ? x.state === ThreadState.WAITING : filter === "running" ? x.state === ThreadState.RUNNING || x.state === ThreadState.QUEUED : true,
	);
	const max = state.maxSessions;
	return (
		<section className="mx-list" aria-label={t.sessions.label(name)}>
			<header className="mx-list-head">
				<Link to={paths.machines()} className="mx-switch" aria-label={`${t.sessions.switchMachine}: ${name}`}>
					<span className="mx-ico sm">
						<MachineIcon name="monitor" small />
						<span className={online ? "dot on" : "dot off"} />
					</span>
					<span className="tx">
						<b>{name}</b>
						<small>{online ? `${t.status.online} · ${t.sessionsCount(state.threads.length)}` : t.link.connecting}</small>
					</span>
				</Link>
				<Link to={paths.machineInfo(machine)} className="icon-btn" aria-label={t.sessions.info}>
					<Icon name="info" />
				</Link>
				<button type="button" className="btn btn-primary btn-sm" disabled={!online} onClick={() => setCreating(true)}>
					<Icon name="plus" small />
					<span>{t.sessions.new}</span>
				</button>
			</header>
			<div className="tabs mx-filters" role="tablist" aria-label={t.sessions.filters}>
				{(["all", "need", "running"] as const).map((f) => (
					<button key={f} type="button" role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}>
						{f === "all" ? t.sessions.all : f === "need" ? t.sessions.need(need) : t.sessions.running}
					</button>
				))}
			</div>
			<ul className="mx-rows">
				{shown.map((thread) => {
					const key = stateKey(thread);
					return (
						<li key={thread.id}>
							<Link to={paths.machineSession(machine, thread.id)} className="mx-row session" current={thread.id === current}>
								<span className={`mx-st ${key}`} aria-hidden="true">
									{key === "running" ? <span className="spin" /> : <MachineIcon name={key === "waiting" ? "help" : "terminal"} small />}
								</span>
								<span className="tx">
									<span className="name">{thread.title}</span>
									<span className="sub">
										<span className="mx-tag">{aiName(state.info, thread.provider)}</span> · {folderName(thread.dir)}
									</span>
								</span>
								<span className="meta">
									<span>{key === "idle" && !thread.open ? t.sessions.state.parked : key === "idle" ? timeAgo(t, Number(thread.updatedAt), now) : t.sessions.state[key]}</span>
									{thread.pending > 0 && (
										<span className="badge" aria-label={t.sessions.waiting(thread.pending)}>
											{thread.pending}
										</span>
									)}
								</span>
							</Link>
						</li>
					);
				})}
			</ul>
			{state.listed && shown.length === 0 && <p className="note mx-pad">{state.threads.length === 0 ? t.sessions.empty : t.sessions.emptyFilter}</p>}
			{max > 0 && (
				<div className="mx-capacity">
					<span>
						{t.sessions.capacity(state.openSessions, max)}
						{state.info !== null && state.info.memoryMb > 0 && ` · ${t.sessions.memory(state.info.memoryMb)}`}
					</span>
					<span className="bar" aria-hidden="true">
						{Array.from({ length: max }, (_, i) => (
							<i key={i} className={i < state.openSessions ? "on" : undefined} />
						))}
					</span>
					<span>{t.sessions.idleNote}</span>
				</div>
			)}
			{creating && <NewSession machine={machine} name={name} link={link} state={state} onClose={() => setCreating(false)} />}
		</section>
	);
}
