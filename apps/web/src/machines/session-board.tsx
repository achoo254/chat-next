// The boards of AI Agent. "Cần bạn" (home): what waits for the user on every
// machine, answerable right on the tile, then what runs and the recent
// sessions. A machine's board: the same for one machine, with its state in
// words, "Phiên mới" (or pairing when this device cannot use it yet) and its
// capacity. The machine board is also the target of a machine push:
// /ai/<id>?session=<thread> opens the thread.
import { useEffect, useState } from "react";
import { create } from "@bufbuild/protobuf";
import { AnswersSchema, PromptState, ThreadState, type Decision, type ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../components/screen-icons.tsx";
import { Link, navigate, paths, useSearch } from "../router.tsx";
import { ApprovalCard } from "./cards/approval.tsx";
import { QuestionCard } from "./cards/question.tsx";
import type { MachineLink } from "./link/machine-link.ts";
import { LOCAL_REF } from "./link/link-hub.ts";
import { DiskAccessBanner } from "./disk-access-banner.tsx";
import { LinkBanner } from "./link-banner.tsx";
import { MachineIcon } from "./machine-icons.tsx";
import { FirstMachine } from "./first-machine.tsx";
import { needsPairing } from "./machine-status.ts";
import { NewSession } from "./new-session.tsx";
import { PageHead } from "./page-head.tsx";
import { connText } from "./session-sidebar.tsx";
import { EMPTY_JOURNAL, orderedItems } from "./transcript/reducer.ts";
import { aiName, errorText, folderName, providerOf, timeAgo, useHub, useMachineViews, useNow, useWatch, type MachineView } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

const SESSION_PARAM = /^[A-Za-z0-9_-]{1,64}$/;
const RECENT = 8;

interface Placed {
	machine: MachineView;
	thread: ThreadSummary;
}

function collect(machines: readonly MachineView[]) {
	const need: Placed[] = [];
	const running: Placed[] = [];
	const idle: Placed[] = [];
	for (const machine of machines) {
		for (const thread of machine.state.threads) {
			const placed = { machine, thread };
			if (thread.state === ThreadState.WAITING) need.push(placed);
			else if (thread.state === ThreadState.RUNNING || thread.state === ThreadState.QUEUED) running.push(placed);
			else idle.push(placed);
		}
	}
	const newest = (a: Placed, b: Placed) => (a.thread.updatedAt === b.thread.updatedAt ? 0 : a.thread.updatedAt > b.thread.updatedAt ? -1 : 1);
	return { need: need.sort(newest), running: running.sort(newest), idle: idle.sort(newest) };
}

/** "Cần bạn" of every machine: the home of AI Agent. */
export function HomeBoard({ back }: { back: boolean }) {
	const t = useMachinesCopy();
	const hub = useHub();
	const now = useNow();
	const machines = useMachineViews(hub, now);
	const { need, running, idle } = collect(machines);
	const many = machines.length > 1;
	const ready = hub.directory().status !== "loading";
	return (
		<div className="mx-scroll">
			<PageHead {...(back ? { back: paths.machines() } : {})} backLabel={t.backToMachines} title={t.agent.home.title} subtitle={t.agent.home.summary(need.length, running.length)} />
			<div className="mx-body">
				{ready && machines.length === 0 && <FirstMachine />}
				{machines.length > 0 && need.length === 0 && (
					<div className="mx-calm">
						<Icon name="check" />
						<div>
							<strong>{t.agent.home.nothing}</strong>
							<p className="muted">{t.agent.home.nothingBody}</p>
						</div>
					</div>
				)}
				<Tiles need={need} running={running} showMachine={many} />
				<Recent list={idle.slice(0, RECENT)} showMachine={many} now={now} />
			</div>
		</div>
	);
}

/** One machine's board. */
export function MachineBoard({ machine }: { machine: string }) {
	const t = useMachinesCopy();
	const hub = useHub();
	const now = useNow();
	const search = useSearch();
	const view = useMachineViews(hub, now).find((m) => m.entry.ref === machine);
	const [creating, setCreating] = useState(false);
	// A push opens /ai/<id>?session=<thread>: go straight to that thread.
	useEffect(() => {
		const session = new URLSearchParams(search).get("session");
		if (session !== null && SESSION_PARAM.test(session)) navigate(paths.machineSession(machine, session), { replace: true });
	}, [search, machine]);
	if (view === undefined) {
		return (
			<div className="mx-scroll">
				<PageHead back={paths.machines()} backLabel={t.backToMachines} title={t.agent.title} />
				<div className="mx-body">
					<p className="muted">{hub.directory().status === "loading" ? "" : t.notFound}</p>
				</div>
			</div>
		);
	}
	const { entry, link, state, conn } = view;
	const { need, running, idle } = collect([view]);
	const pairPath = machine === LOCAL_REF ? paths.machinesLocal() : paths.machinePair(machine);
	const max = state.maxSessions;
	return (
		<div className="mx-scroll" role="region" aria-label={t.agent.machineBoardOf(entry.name)}>
			<PageHead back={paths.machines()} backLabel={t.backToMachines} title={entry.name} subtitle={connText(t, conn, now)}>
				<Link to={paths.machineInfo(machine)} className="icon-btn" aria-label={t.agent.info}>
					<Icon name="info" />
				</Link>
				{!needsPairing(conn) && (
					<button
						type="button"
						className="btn btn-primary btn-sm"
						disabled={conn.kind !== "on"}
						title={conn.kind === "on" ? undefined : t.agent.newDisabled(connText(t, conn, now))}
						onClick={() => setCreating(true)}
					>
						<Icon name="plus" small />
						{t.agent.newSession}
					</button>
				)}
			</PageHead>
			{!needsPairing(conn) && <LinkBanner machine={machine} name={entry.name} status={state.status} />}
			<div className="mx-body">
				<DiskAccessBanner link={link} info={state.info} online={state.status.kind === "open"} />
				{needsPairing(conn) && (
					<div className="empty">
						<MachineIcon name="shield" />
						<h2>{t.agent.conn[conn.kind === "unpaired" ? "unpaired" : "repair"]}</h2>
						<p>{conn.kind === "unpaired" ? t.agent.hint.unpaired : t.agent.hint.repair}</p>
						<Link to={pairPath} className="btn btn-primary">
							{t.agent.pair}
						</Link>
					</div>
				)}
				{conn.kind === "offline" && <p className="muted">{t.agent.hint.offline}</p>}
				{conn.kind === "on" && state.listed && need.length === 0 && running.length === 0 && <p className="muted">{t.board.nothing}</p>}
				<Tiles need={need} running={running} showMachine={false} />
				<Recent list={idle.slice(0, RECENT)} showMachine={false} now={now} />
				{max > 0 && <p className="note">{t.agent.capacity(state.openSessions, max)}</p>}
			</div>
			{creating && <NewSession machine={machine} name={entry.name} link={link} state={state} onClose={() => setCreating(false)} />}
		</div>
	);
}

function Tiles({ need, running, showMachine }: { need: readonly Placed[]; running: readonly Placed[]; showMachine: boolean }) {
	const t = useMachinesCopy();
	return (
		<>
			{need.length > 0 && (
				<>
					<h3 className="mx-section">{t.board.need(need.length)}</h3>
					<div className="mx-board">
						{need.map(({ machine, thread }) => (
							<WaitingTile key={`${machine.entry.ref}/${thread.id}`} machine={machine} thread={thread} showMachine={showMachine} />
						))}
					</div>
				</>
			)}
			{running.length > 0 && (
				<>
					<h3 className="mx-section">{t.board.running(running.length)}</h3>
					<div className="mx-board">
						{running.map(({ machine, thread }) => (
							<RunningTile key={`${machine.entry.ref}/${thread.id}`} machine={machine} thread={thread} showMachine={showMachine} />
						))}
					</div>
				</>
			)}
		</>
	);
}

function TileHead({ machine, thread, showMachine, waiting }: { machine: MachineView; thread: ThreadSummary; showMachine: boolean; waiting: boolean }) {
	const t = useMachinesCopy();
	return (
		<>
			<h4>
				{waiting ? <MachineIcon name="help" small /> : <span className="spin" aria-hidden="true" />}
				<Link to={paths.machineSession(machine.entry.ref, thread.id)} className="mx-tile-title">
					{thread.title || t.agent.newSession}
				</Link>
				{thread.pending > 0 && <span className="badge">{thread.pending}</span>}
			</h4>
			<span className="dir">
				{showMachine && `${machine.entry.name} · `}
				{folderName(thread.dir)}
			</span>
		</>
	);
}

function RunningTile({ machine, thread, showMachine }: { machine: MachineView; thread: ThreadSummary; showMachine: boolean }) {
	const t = useMachinesCopy();
	return (
		<div className="mx-tile">
			<TileHead machine={machine} thread={thread} showMachine={showMachine} waiting={false} />
			<div className="acts">
				<Link to={paths.machineSession(machine.entry.ref, thread.id)} className="btn btn-sm">
					{t.board.open}
				</Link>
				<button
					type="button"
					className="btn btn-sm danger-outline"
					onClick={() => machine.link.request({ case: "threadInterrupt", value: { threadId: thread.id } }).catch(() => undefined)}
				>
					<MachineIcon name="stop" small />
					{t.board.stop}
				</button>
			</div>
		</div>
	);
}

function WaitingTile({ machine, thread, showMachine }: { machine: MachineView; thread: ThreadSummary; showMachine: boolean }) {
	const t = useMachinesCopy();
	const { link, state } = machine;
	useWatch(link, thread.id);
	const items = orderedItems(state.journals.get(thread.id) ?? EMPTY_JOURNAL);
	const ai = aiName(state.info, thread.provider);
	const prompt = items.findLast((i) => (i.body.case === "approval" || i.body.case === "question") && i.body.value.state === PromptState.PENDING);
	const respond = async (answer: Parameters<MachineLink["request"]>[0]) => {
		try {
			await link.request(answer);
		} catch (err) {
			throw new Error(errorText(t, err, ai), { cause: err });
		}
	};
	return (
		<div className="mx-tile need">
			<TileHead machine={machine} thread={thread} showMachine={showMachine} waiting />
			{prompt === undefined ? (
				<p className="muted">{t.board.loading}</p>
			) : prompt.body.case === "approval" ? (
				<ApprovalCard
					compact
					approval={prompt.body.value}
					ai={ai}
					sessionAllow={providerOf(state.info, thread.provider)?.capabilities?.sessionAllow ?? false}
					onDecide={(decision: Decision) =>
						respond({
							case: "threadRespond",
							value: { threadId: thread.id, itemId: prompt.id, expectedRevision: prompt.revision, answer: { case: "decision", value: decision } },
						})
					}
				/>
			) : prompt.body.case === "question" ? (
				<QuestionCard
					compact
					question={prompt.body.value}
					ai={ai}
					onAnswer={(answers) =>
						respond({
							case: "threadRespond",
							value: {
								threadId: thread.id,
								itemId: prompt.id,
								expectedRevision: prompt.revision,
								answer: { case: "answers", value: create(AnswersSchema, { answers: answers.map((values) => ({ values })) }) },
							},
						})
					}
				/>
			) : null}
			<div className="acts">
				<Link to={paths.machineSession(machine.entry.ref, thread.id)} className="btn btn-sm">
					{t.board.open}
				</Link>
			</div>
		</div>
	);
}

function Recent({ list, showMachine, now }: { list: readonly Placed[]; showMachine: boolean; now: number }) {
	const t = useMachinesCopy();
	if (list.length === 0) return null;
	return (
		<>
			<h3 className="mx-section">{t.agent.home.recent}</h3>
			<ul className="mx-recent">
				{list.map(({ machine, thread }) => {
					const online = machine.conn.kind === "on";
					const body = (
						<>
							<MachineIcon name="terminal" small />
							<span className="tx">
								<b>{thread.title || t.agent.newSession}</b>
								<small>
									{showMachine && `${machine.entry.name} · `}
									{folderName(thread.dir)} · {timeAgo(t, Number(thread.updatedAt), now)}
								</small>
							</span>
							<span className="go">{t.agent.home.resume}</span>
						</>
					);
					return (
						<li key={`${machine.entry.ref}/${thread.id}`}>
							{online ? (
								<Link to={paths.machineSession(machine.entry.ref, thread.id)} className="mx-recent-row">
									{body}
								</Link>
							) : (
								<div className="mx-recent-row disabled" aria-disabled="true" title={t.agent.openDisabled(connText(t, machine.conn, now))}>
									{body}
								</div>
							)}
						</li>
					);
				})}
			</ul>
		</>
	);
}
