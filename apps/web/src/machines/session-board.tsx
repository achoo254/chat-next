// "Bảng phiên": the machine's sessions that need the user (with the waiting
// approval or question answerable right on the tile) and those running (with
// Stop), so several sessions are handled without opening each one. Also the
// target of a machine push: /machines/<id>?session=<thread> opens the thread.
import { useEffect } from "react";
import { create } from "@bufbuild/protobuf";
import { AnswersSchema, PromptState, ThreadState, type Decision, type ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { Link, navigate, paths, useSearch } from "../router.tsx";
import { ApprovalCard } from "./cards/approval.tsx";
import { QuestionCard } from "./cards/question.tsx";
import type { LinkState, MachineLink } from "./link/machine-link.ts";
import { LinkBanner } from "./link-banner.tsx";
import { MachineIcon } from "./machine-icons.tsx";
import { PageHead } from "./page-head.tsx";
import { EMPTY_JOURNAL, orderedItems } from "./transcript/reducer.ts";
import { aiName, errorText, folderName, providerOf, useEntry, useHub, useLink, useWatch } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

const SESSION_PARAM = /^[A-Za-z0-9_-]{1,64}$/;

export function SessionBoard({ machine }: { machine: string }) {
	const t = useMachinesCopy();
	const hub = useHub();
	const entry = useEntry(hub, machine);
	const [link, state] = useLink(hub, machine);
	const search = useSearch();
	// A push opens /machines/<id>?session=<thread>: go straight to that thread.
	useEffect(() => {
		const session = new URLSearchParams(search).get("session");
		if (session !== null && SESSION_PARAM.test(session)) navigate(paths.machineSession(machine, session), { replace: true });
	}, [search, machine]);
	const name = entry?.name ?? "";
	const need = state.threads.filter((x) => x.state === ThreadState.WAITING);
	const running = state.threads.filter((x) => x.state === ThreadState.RUNNING || x.state === ThreadState.QUEUED);
	const idle = state.threads.length - need.length - running.length;
	return (
		<div className="mx-scroll">
			<PageHead back={paths.machines()} backLabel={t.backToMachines} title={t.board.title(name)} subtitle={state.listed ? t.board.summary(need.length, running.length, idle) : undefined} />
			<LinkBanner machine={machine} name={name} status={state.status} />
			<div className="mx-body">
				{state.listed && need.length === 0 && running.length === 0 && <p className="muted">{t.board.nothing}</p>}
				{need.length > 0 && (
					<>
						<p className="mx-section">{t.board.need(need.length)}</p>
						<div className="mx-board">
							{need.map((thread) => (
								<WaitingTile key={thread.id} machine={machine} link={link} state={state} thread={thread} />
							))}
						</div>
					</>
				)}
				{running.length > 0 && (
					<>
						<p className="mx-section">{t.board.running(running.length)}</p>
						<div className="mx-board">
							{running.map((thread) => (
								<div key={thread.id} className="mx-tile">
									<h4>
										<span className="spin" aria-hidden="true" />
										<span>{thread.title}</span>
									</h4>
									<span className="dir">{folderName(thread.dir)}</span>
									<div className="acts">
										<Link to={paths.machineSession(machine, thread.id)} className="btn btn-sm">
											{t.board.open}
										</Link>
										<button
											type="button"
											className="btn btn-sm btn-danger"
											onClick={() => link.request({ case: "threadInterrupt", value: { threadId: thread.id } }).catch(() => undefined)}
										>
											<MachineIcon name="stop" small />
											{t.board.stop}
										</button>
									</div>
								</div>
							))}
						</div>
					</>
				)}
			</div>
		</div>
	);
}

function WaitingTile({ machine, link, state, thread }: { machine: string; link: MachineLink; state: LinkState; thread: ThreadSummary }) {
	const t = useMachinesCopy();
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
			<h4>
				<MachineIcon name="help" small />
				<span>{thread.title}</span>
				{thread.pending > 0 && <span className="badge">{thread.pending}</span>}
			</h4>
			<span className="dir">{folderName(thread.dir)}</span>
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
				<Link to={paths.machineSession(machine, thread.id)} className="btn btn-sm">
					{t.board.open}
				</Link>
			</div>
		</div>
	);
}
