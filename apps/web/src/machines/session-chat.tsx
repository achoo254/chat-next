// One session (thread) of a machine: the transcript with tool rows, diffs,
// todos, approval and question cards, the model/AI menu, the status bar
// (ThreadInfo) and the composer.
// The thread is watched on the machine's shared link while this shows, so a
// reconnect resubscribes from the cursor and a reset reloads the snapshot.
import { useEffect, useRef, useState } from "react";
import { create } from "@bufbuild/protobuf";
import { AnswersSchema, LoginState, ThreadState, TurnState, type Decision, type MachineInfo } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../components/screen-icons.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { ConfirmDialog } from "../messaging/bots/dialogs.tsx";
import { paths } from "../router.tsx";
import { ApprovalCard } from "./cards/approval.tsx";
import { DiffCard } from "./cards/diff.tsx";
import { QuestionCard } from "./cards/question.tsx";
import { TodoCard } from "./cards/todo.tsx";
import { ToolRunCard } from "./cards/tool-run.tsx";
import { Composer } from "./composer.tsx";
import type { MachinesCopy } from "./copy-vi.ts";
import type { LinkState, MachineLink } from "./link/machine-link.ts";
import { LinkBanner } from "./link-banner.tsx";
import { MachineIcon } from "./machine-icons.tsx";
import { PageHead } from "./page-head.tsx";
import { StatusBar } from "./status-bar.tsx";
import { EMPTY_JOURNAL, orderedItems } from "./transcript/reducer.ts";
import { contextShare, currentModel, foldTranscript, turnRunning, type Block } from "./transcript/tool-fold.ts";
import { aiName, errorText, modelName, providerOf, stateKey, useEntry, useHub, useLink, useWatch } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

export function SessionChat({ machine, threadId }: { machine: string; threadId: string }) {
	const t = useMachinesCopy();
	const hub = useHub();
	const entry = useEntry(hub, machine);
	const [link, state] = useLink(hub, machine);
	useWatch(link, threadId);
	const thread = state.threads.find((x) => x.id === threadId) ?? null;
	const items = orderedItems(state.journals.get(threadId) ?? EMPTY_JOURNAL);
	const blocks = foldTranscript(items, state.pending.get(threadId) ?? []);
	const provider = thread?.provider ?? items.at(-1)?.provider ?? "";
	const ai = aiName(state.info, provider);
	const caps = providerOf(state.info, provider)?.capabilities;
	const online = state.status.kind === "open";
	const running = turnRunning(items) || thread?.state === ThreadState.RUNNING || thread?.state === ThreadState.WAITING || thread?.state === ThreadState.QUEUED;
	const threadInfo = state.threadInfo.get(threadId);
	const model = currentModel(items, thread?.model ?? "");
	const machineName = entry?.name ?? "";
	const missing = online && state.listed && thread === null && items.length === 0;

	const request = async (body: Parameters<MachineLink["request"]>[0]): Promise<void> => {
		try {
			await link.request(body);
		} catch (err) {
			throw new Error(errorText(t, err, ai), { cause: err });
		}
	};
	const decide = (itemId: string, revision: number) => (decision: Decision) =>
		request({ case: "threadRespond", value: { threadId, itemId, expectedRevision: revision, answer: { case: "decision", value: decision } } });
	const answer = (itemId: string, revision: number) => (answers: string[][]) =>
		request({
			case: "threadRespond",
			value: { threadId, itemId, expectedRevision: revision, answer: { case: "answers", value: create(AnswersSchema, { answers: answers.map((values) => ({ values })) }) } },
		});
	const fetchFull = (itemId: string) => request({ case: "threadFetchFull", value: { threadId, itemId } });

	const chip = !online ? "offline" : thread === null ? null : stateKey(thread);
	return (
		<div className="mx-chat">
			<PageHead
				back={paths.machine(machine)}
				backLabel={t.sessions.label(machineName)}
				title={thread?.title ?? ""}
				subtitle={
					<>
						<MachineIcon name="monitor" small />
						{machineName}
						{thread !== null && (
							<>
								{" · "}
								<span className="mono">{thread.dir}</span>
							</>
						)}
					</>
				}
			>
				{chip !== null && <span className={`chip mx-chip ${chip}`}>{t.chat.chip[chip]}</span>}
				<span className="mx-e2ee" title={t.link.e2ee} role="img" aria-label={t.link.e2ee}>
					<Icon name="lock" small />
				</span>
				{thread !== null && <ModelMenu link={link} info={state.info} threadId={threadId} provider={thread.provider} model={thread.model} disabled={!online} />}
			</PageHead>
			<LinkBanner machine={machine} name={machineName} status={state.status} />
			{missing ? (
				<div className="empty">
					<p>{t.chat.notFound}</p>
				</div>
			) : (
				<Transcript
					blocks={blocks}
					state={state}
					ai={ai}
					sessionAllow={caps?.sessionAllow ?? false}
					running={running}
					decide={decide}
					answer={answer}
					fetchFull={fetchFull}
				/>
			)}
			{!missing && (
				<StatusBar
					ai={ai}
					dir={thread?.dir ?? ""}
					model={model === "" ? "" : modelName(state.info, provider, model)}
					context={contextShare(items)}
					info={threadInfo}
				/>
			)}
			<Composer
				ai={ai}
				machine={machineName}
				online={online && !missing}
				running={running}
				commands={threadInfo?.commands ?? []}
				onSend={(text) => link.send(threadId, text)}
				onStop={() => request({ case: "threadInterrupt", value: { threadId } })}
			/>
		</div>
	);
}

interface TranscriptProps {
	blocks: readonly Block[];
	state: LinkState;
	ai: string;
	sessionAllow: boolean;
	running: boolean;
	decide: (itemId: string, revision: number) => (decision: Decision) => Promise<void>;
	answer: (itemId: string, revision: number) => (answers: string[][]) => Promise<void>;
	fetchFull: (itemId: string) => Promise<void>;
}

function Transcript({ blocks, state, ai, sessionAllow, running, decide, answer, fetchFull }: TranscriptProps) {
	const t = useMachinesCopy();
	const scroller = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const last = blocks.at(-1);
	const tail = last === undefined ? "" : `${blocks.length}:${last.kind === "text" ? last.text.length : last.id}`;
	// New content scrolls into view unless the user scrolled up to read.
	useEffect(() => {
		const el = scroller.current;
		if (el !== null && stick.current) el.scrollTop = el.scrollHeight;
	}, [tail]);
	const typing = running && !(last?.kind === "text" && last.partial);
	return (
		<div
			ref={scroller}
			className="mx-messages"
			onScroll={(event) => {
				const el = event.currentTarget;
				stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
			}}
		>
			{blocks.length === 0 && !running && <p className="muted mx-center">{t.transcript.empty}</p>}
			{blocks.map((block) => (
				<BlockView key={block.id} block={block} state={state} ai={ai} sessionAllow={sessionAllow} running={running} decide={decide} answer={answer} fetchFull={fetchFull} t={t} />
			))}
			{typing && (
				<div className="mx-typing" role="status" aria-label={t.chat.typing(ai)}>
					<i />
					<i />
					<i />
				</div>
			)}
		</div>
	);
}

function BlockView({ block, state, ai, sessionAllow, running, decide, answer, fetchFull, t }: Omit<TranscriptProps, "blocks"> & { block: Block; t: MachinesCopy }) {
	const { locale } = useI18n();
	switch (block.kind) {
		case "user":
			return (
				<div className="mx-msg mine">
					<div className="bubble" aria-busy={block.pending}>
						{block.text}
						{block.pending && <span className="sr-only">{t.chat.sending}</span>}
					</div>
				</div>
			);
		case "text":
			return <div className={block.partial ? "mx-agent streaming" : "mx-agent"}>{block.text}</div>;
		case "who":
			return (
				<div className="mx-who">
					<span className="mx-tag">
						{aiName(state.info, block.provider)}
						{block.model !== "" && ` · ${modelName(state.info, block.provider, block.model)}`}
					</span>
				</div>
			);
		case "tools":
			return <ToolRunCard runs={block.runs} full={state.full} onFetchFull={fetchFull} live={running} />;
		case "diff": {
			const full = state.full.get(block.id);
			return <DiffCard diff={block.diff} full={full?.body.case === "diff" ? full.body.value : null} onFetchFull={() => fetchFull(block.id)} />;
		}
		case "todo":
			return <TodoCard todo={block.todo} />;
		case "approval":
			return <ApprovalCard approval={block.approval} ai={ai} sessionAllow={sessionAllow} onDecide={decide(block.id, block.revision)} />;
		case "question":
			return <QuestionCard question={block.question} ai={ai} onAnswer={answer(block.id, block.revision)} />;
		case "turn": {
			const turn = block.turn;
			const text =
				turn.state === TurnState.COMPLETED
					? t.transcript.turnDone(`${(Number(turn.durationMs) / 1000).toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`)
					: turn.state === TurnState.INTERRUPTED
						? t.transcript.turnInterrupted
						: t.transcript.turnFailed;
			return <div className={turn.state === TurnState.FAILED ? "mx-line error" : "mx-line"}>{text}</div>;
		}
		case "model":
			return <div className="mx-divider">{t.transcript.model(block.from, block.to)}</div>;
		case "handoff":
			return (
				<details className="mx-handoff">
					<summary>
						<MachineIcon name="chevron-right" small />
						{t.transcript.handoff(block.handoff.to)}
					</summary>
					{block.handoff.filesChanged.length > 0 && (
						<>
							<b>{t.transcript.filesChanged}</b>
							<ul>
								{block.handoff.filesChanged.map((file) => (
									<li key={file} className="mono">
										{file}
									</li>
								))}
							</ul>
						</>
					)}
					<pre className="mx-pre">{block.handoff.summary}</pre>
					<p className="muted">{t.transcript.handoffNote(block.handoff.to)}</p>
				</details>
			);
		case "compaction":
			return <div className="mx-line">{t.transcript.compaction}</div>;
		case "status":
			return <div className="mx-line">{block.text}</div>;
		case "error":
			return (
				<div className="mx-line error" role="alert">
					{block.message}
				</div>
			);
	}
}

interface ModelMenuProps {
	link: MachineLink;
	info: MachineInfo | null;
	threadId: string;
	provider: string;
	model: string;
	disabled: boolean;
}

/** "Claude Code · Opus ▾": the AI's models, and switching to another AI when the machine has two or more. */
function ModelMenu({ link, info, threadId, provider, model, disabled }: ModelMenuProps) {
	const t = useMachinesCopy();
	const [open, setOpen] = useState(false);
	const [switchTo, setSwitchTo] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const menu = useRef<HTMLDivElement>(null);
	const ai = aiName(info, provider);
	const models = providerOf(info, provider)?.capabilities?.models ?? [];
	const others = (info?.providers ?? []).filter((p) => p.id !== provider);
	useEffect(() => {
		if (!open) return;
		const onDown = (event: PointerEvent) => {
			if (menu.current !== null && !menu.current.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: globalThis.KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);
	const run = (body: Parameters<MachineLink["request"]>[0], done: () => void) => {
		setBusy(true);
		setError("");
		link.request(body).then(
			() => {
				setBusy(false);
				done();
			},
			(err: unknown) => {
				setBusy(false);
				setError(errorText(t, err, ai));
			},
		);
	};
	const label = model === "" ? ai : `${ai} · ${modelName(info, provider, model)}`;
	return (
		<div className="mx-model" ref={menu}>
			<button type="button" className="mx-model-btn" aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen((v) => !v)}>
				<span className="hide-narrow">{label}</span>
				<span className="narrow-only">{model === "" ? ai : modelName(info, provider, model)}</span>
				<MachineIcon name="chevron-down" small />
			</button>
			{open && (
				<div className="mx-menu" role="menu" aria-label={t.chat.modelMenu}>
					<h5>{t.chat.modelsOf(ai)}</h5>
					{models.map((m) => (
						<button
							key={m.id}
							type="button"
							role="menuitemradio"
							aria-checked={m.id === model}
							disabled={busy}
							onClick={() => run({ case: "threadSetModel", value: { threadId, model: m.id } }, () => setOpen(false))}
						>
							{m.id === model ? <Icon name="check" small /> : <span className="mx-menu-gap" />}
							<span>{m.name || m.id}</span>
						</button>
					))}
					{others.length > 0 && (
						<>
							<hr />
							<h5>{t.chat.switchAi}</h5>
							{others.map((p) => {
								const usable = p.loginState !== LoginState.NEEDS_LOGIN;
								return (
									<button
										key={p.id}
										type="button"
										role="menuitem"
										disabled={busy || !usable}
										onClick={() => {
											setOpen(false);
											setSwitchTo(p.id);
										}}
									>
										<MachineIcon name="chevron-right" small />
										<span>
											{p.name || p.id}
											<small>{usable ? t.chat.switchHint : t.newSession.needsLogin}</small>
										</span>
									</button>
								);
							})}
						</>
					)}
					{error !== "" && (
						<p className="mx-error" role="alert">
							{error}
						</p>
					)}
				</div>
			)}
			{switchTo !== null && (
				<ConfirmDialog
					title={t.chat.switchTitle(aiName(info, switchTo))}
					body={
						<>
							<p>{t.chat.switchBody(aiName(info, switchTo))}</p>
							{error !== "" && (
								<p className="mx-error" role="alert">
									{error}
								</p>
							)}
						</>
					}
					action={t.chat.switchAction}
					busyLabel={t.chat.switching}
					busy={busy}
					danger={false}
					onConfirm={() => run({ case: "threadSwitch", value: { threadId, provider: switchTo, model: "" } }, () => setSwitchTo(null))}
					onClose={() => setSwitchTo(null)}
				/>
			)}
		</div>
	);
}
