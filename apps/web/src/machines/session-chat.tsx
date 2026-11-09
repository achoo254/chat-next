// One AI session (thread) of a machine: a short header (title, folder,
// state, "Thay đổi", a menu with the machine and the encryption), the
// transcript (markdown answers, tool rows, diffs, todos, results of answered
// prompts), the prompts waiting for the user docked above the composer, the
// status bar and the composer. "Thay đổi" opens what changed in the folder
// (git, tunelo 2.0.11+) and the files the AI edited.
// The thread is watched on the machine's shared link while this shows, so a
// reconnect resubscribes from the cursor and a reset reloads the snapshot.
// Files dragged anywhere over the session go to the composer when dropped.
import { useCallback, useEffect, useRef, useState } from "react";
import { create } from "@bufbuild/protobuf";
import { AnswersSchema, Decision, ErrorCode, PromptState, ThreadState, type GitFileChange, type SecretPrompt, type ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../components/screen-icons.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { Link, navigate, paths } from "../router.tsx";
import { ApprovalCard } from "./cards/approval.tsx";
import { DiffCard } from "./cards/diff.tsx";
import { QuestionCard } from "./cards/question.tsx";
import { SecretCard } from "./cards/secret-request.tsx";
import { TodoCard } from "./cards/todo.tsx";
import { ToolRunCard } from "./cards/tool-run.tsx";
import { TurnLine } from "./cards/turn-line.tsx";
import { AccountMenu, profileName } from "./account-menu.tsx";
import { limitsOf, type UploadLink } from "./attachments.ts";
import { DropZone, MessageAttachments, useFileDrop } from "./attachment-tray.tsx";
import { ChangesPanel, changesCount } from "./changes-panel.tsx";
import { Composer, type FileListing, type ListFiles } from "./composer.tsx";
import type { MachinesCopy } from "./copy-vi.ts";
import { RemoteError, type LinkState, type MachineLink } from "./link/machine-link.ts";
import { DeleteThreadDialog, ThreadMenuItems, threadActionsSupported } from "./thread-actions.tsx";
import { DiskAccessBanner } from "./disk-access-banner.tsx";
import { LinkBanner } from "./link-banner.tsx";
import { MachineIcon } from "./machine-icons.tsx";
import { profileById, sessionProfileId, switchPending, useProfiles } from "./machine-profile.ts";
import { PageHead } from "./page-head.tsx";
import { AgentText } from "./rich/agent-text.tsx";
import { StatusBar } from "./status-bar.tsx";
import { sessionChanges } from "./transcript/changes.ts";
import { EMPTY_JOURNAL, orderedItems } from "./transcript/reducer.ts";
import { contextShare, currentModel, foldTranscript, turnRunning, type Block } from "./transcript/tool-fold.ts";
import { aiName, errorText, folderName, modelName, providerOf, stateKey, useEntry, useHub, useLink, useWatch } from "./use-machines.ts";
import { useAttachments } from "./use-attachments.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";
import { usePopover } from "./use-popover.ts";
import { versionAtLeast } from "./agent-version.ts";
import { BrowserDock, BrowserViewHost, ScreenViewHost } from "./browser/takeover-card.tsx";

export { versionAtLeast };

/** The first tunelo that takes a message with a denial and lists a session's files. */
const AGENT_2_0_1 = [2, 0, 1] as const;

type Pending = Extract<Block, { kind: "approval" | "question" }>;

function isPending(block: Block): block is Pending {
	return (block.kind === "approval" && block.approval.state === PromptState.PENDING) || (block.kind === "question" && block.question.state === PromptState.PENDING);
}

export function SessionChat({ machine, threadId }: { machine: string; threadId: string }) {
	const t = useMachinesCopy();
	const hub = useHub();
	const entry = useEntry(hub, machine);
	const [link, state] = useLink(hub, machine);
	useWatch(link, threadId);
	const [changesOpen, setChangesOpen] = useState(false);
	const thread = state.threads.find((x) => x.id === threadId) ?? null;
	const items = orderedItems(state.journals.get(threadId) ?? EMPTY_JOURNAL);
	const all = foldTranscript(items, state.pending.get(threadId) ?? []);
	const blocks = all.filter((b) => !isPending(b));
	const prompts = all.filter(isPending);
	const secretPrompts = [...state.secretPrompts.values()].filter((p) => p.threadId === threadId);
	const takeovers = [...state.takeovers.values()].filter((x) => x.threadId === threadId);
	const passkeys = state.passkeyNotices.filter((n) => n.threadId === threadId);
	/** The takeover whose live view shows over the session. */
	const [viewing, setViewing] = useState<string | null>(null);
	const viewed = viewing === null ? undefined : state.takeovers.get(viewing);
	/** The machine's whole screen shows over the session. */
	const [screenOpen, setScreenOpen] = useState(false);
	const openScreen = state.info?.screenShare === true ? () => setScreenOpen(true) : undefined;
	const outside = secretPrompts.length + takeovers.length;
	const changes = sessionChanges(items);
	const gitSupported = state.info?.gitChanges === true;
	const git = state.gitChanges.get(threadId) ?? null;
	const changeCount = changesCount(changes, gitSupported ? git : null);
	const provider = thread?.provider ?? items.at(-1)?.provider ?? "";
	const ai = aiName(state.info, provider);
	const caps = providerOf(state.info, provider)?.capabilities;
	const online = state.status.kind === "open";
	const running = turnRunning(items) || thread?.state === ThreadState.RUNNING || thread?.state === ThreadState.WAITING || thread?.state === ThreadState.QUEUED;
	const threadInfo = state.threadInfo.get(threadId);
	const model = currentModel(items, thread?.model ?? "");
	const machineName = entry?.name ?? "";
	const missing = online && state.listed && thread === null && items.length === 0;
	const modern = versionAtLeast(state.info?.agentVersion ?? "", AGENT_2_0_1);
	const profiles = useProfiles(link, state.machineProfile, online);
	const profileId = sessionProfileId(state.machineProfile, threadId, threadInfo, profiles.list);
	const pending = switchPending(state.machineProfile, threadId, threadInfo);
	const nextProfile = profileById(profiles.list, profiles.list?.selectedId ?? "");
	const switchingTo = !pending ? "" : threadInfo?.nextAccount?.email || nextProfile?.email || t.agent.account.defaultName;
	const suggestion = pending ? undefined : threadInfo?.profileSuggestion;
	const limits = limitsOf(state.info?.attachments);
	const attach = useAttachments(link, threadId, limits, caps?.images ?? false, ai);
	const drop = useFileDrop(online && !missing, (files) => {
		attach.add(files);
		document.querySelector<HTMLTextAreaElement>(".mx-chat [data-composer]")?.focus();
	});

	const fetchFull = async (itemId: string): Promise<void> => {
		await link.request({ case: "threadFetchFull", value: { threadId, itemId } });
	};
	const decide = (itemId: string, revision: number) => async (decision: Decision, message?: string) => {
		const note = decision === Decision.DENY ? (message ?? "") : "";
		await link.request({
			case: "threadRespond",
			value: { threadId, itemId, expectedRevision: revision, answer: { case: "decision", value: decision }, denyMessage: modern ? note : "" },
		});
		// tunelo 2.0.0 drops the message of a denial: it goes as the next message instead.
		if (!modern && note !== "") await link.send(threadId, note);
	};
	const answer = (itemId: string, revision: number) => async (answers: string[][]) => {
		await link.request({
			case: "threadRespond",
			value: { threadId, itemId, expectedRevision: revision, answer: { case: "answers", value: create(AnswersSchema, { answers: answers.map((values) => ({ values })) }) } },
		});
	};
	const listFiles = useCallback<ListFiles>(
		async (prefix) => {
			try {
				const frame = await link.request({ case: "fileList", value: { threadId, prefix, limit: 50 } });
				if (frame.body.case !== "fileListResult") return null;
				const listing: FileListing = { entries: frame.body.value.entries.map((e) => ({ path: e.path, dir: e.dir })), truncated: frame.body.value.truncated };
				return listing;
			} catch {
				// tunelo 2.0.0 does not know the request; offline or a bad prefix: no suggestions.
				return null;
			}
		},
		[link, threadId],
	);
	const closeChanges = useCallback(() => setChangesOpen(false), []);
	// The folder's git changes: once the session shows (for the count), again whenever the panel opens.
	const hasThread = thread !== null;
	useEffect(() => {
		if (!online || !gitSupported || !hasThread) return;
		link.request({ case: "threadGitChanges", value: { threadId } }).catch(() => undefined);
	}, [link, threadId, online, gitSupported, hasThread, changesOpen]);
	const gitFileDiff = async (path: string): Promise<GitFileChange | null> => {
		try {
			const frame = await link.request({ case: "gitFileDiff", value: { threadId, path } });
			return frame.body.case === "gitFileDiffResult" ? (frame.body.value.file ?? null) : null;
		} catch (err) {
			// The file has no uncommitted change any more.
			if (err instanceof RemoteError && err.code === ErrorCode.NOT_FOUND) return null;
			throw err;
		}
	};

	const chip = !online ? "offline" : thread === null ? null : stateKey(thread);
	const dir = thread?.dir ?? "";
	return (
		<div className="mx-chat" data-changes={changesOpen ? "open" : undefined} {...drop.handlers}>
			{drop.dragging && <DropZone ai={ai} maxBytes={limits?.fileMaxBytes ?? 0} supported={limits !== null} />}
			<PageHead
				back={paths.machines()}
				backLabel={t.backToMachines}
				title={thread ? thread.title || t.agent.newSession : ""}
				subtitle={
					<>
						<span className="mono" title={dir}>
							{folderName(dir)}
						</span>
						<span className="hide-narrow">· {machineName}</span>
					</>
				}
			>
				{chip !== null && (
					<span className={`chip mx-chip ${chip}`} role="status" aria-label={t.chat.chip[chip]} title={t.chat.chip[chip]}>
						<span className="hide-narrow" aria-hidden="true">
							{t.chat.chip[chip]}
						</span>
					</span>
				)}
				{thread !== null && (
					<button
						type="button"
						className="btn btn-sm mx-changes-btn"
						aria-label={changeCount > 0 ? `${t.agent.header.changes} (${changeCount})` : t.agent.header.changes}
						aria-expanded={changesOpen}
						onClick={() => setChangesOpen((v) => !v)}
					>
						<MachineIcon name="pencil" small />
						<span className="hide-narrow">{t.agent.header.changes}</span>
						{changeCount > 0 && <span className="count">{changeCount}</span>}
					</button>
				)}
				<HeadMenu
					machine={machine}
					machineName={machineName}
					dir={dir}
					{...(thread !== null && online && threadActionsSupported(state.info) ? { manage: { link, thread, ai } } : {})}
				/>
			</PageHead>
			<LinkBanner machine={machine} name={machineName} status={state.status} />
			<DiskAccessBanner link={link} info={state.info} online={online} />
			<div className="mx-chat-body">
				<div className="mx-chat-main">
					{missing ? (
						<div className="empty">
							<p>{t.chat.notFound}</p>
						</div>
					) : (
						<Transcript blocks={blocks} state={state} running={running} waiting={prompts.length > 0 || outside > 0} fetchFull={fetchFull} link={link} threadId={threadId} />
					)}
					{suggestion !== undefined && (
						<LimitBar
							from={profileName(t, profileById(profiles.list, profileId), threadInfo?.account?.email ?? "")}
							to={suggestion.email}
							left={suggestion.remaining}
							onSwitch={() => profiles.request({ case: "profileSelect", value: { id: suggestion.profileId } })}
							ai={ai}
						/>
					)}
					{secretPrompts.length > 0 && <SecretDock prompts={secretPrompts} ai={ai} link={link} />}
					{(takeovers.length > 0 || passkeys.length > 0) && <BrowserDock link={link} takeovers={takeovers} notices={passkeys} ai={ai} onView={setViewing} onScreen={openScreen} />}
					{prompts.length > 0 && (
						<Dock prompts={prompts} ai={ai} sessionAllow={caps?.sessionAllow ?? false} decide={decide} answer={answer} />
					)}
					{!missing && (
						<StatusBar
							ai={ai}
							dir={dir}
							machine={state.info}
							provider={provider}
							model={model}
							context={contextShare(items)}
							info={threadInfo}
							link={link}
							threadId={threadId}
							online={online}
							switchingTo={switchingTo}
							account={
								<AccountMenu
									ai={ai}
									machine={machine}
									link={link}
									profiles={profiles}
									current={profileId}
									fallbackEmail={threadInfo?.account?.email ?? ""}
									disabled={!online}
								/>
							}
						/>
					)}
					<Composer
						ai={ai}
						machine={machineName}
						online={online && !missing}
						running={running}
						prompting={prompts.length > 0 || outside > 0}
						commands={threadInfo?.commands ?? []}
						listFiles={modern ? listFiles : undefined}
						attach={attach}
						onSend={(text, files) => link.send(threadId, text, files)}
						onStop={async () => {
							await link.request({ case: "threadInterrupt", value: { threadId } });
						}}
					/>
				</div>
				{screenOpen && <ScreenViewHost link={link} ai={ai} online={online} inSession onClose={() => setScreenOpen(false)} />}
				{viewed !== undefined && <BrowserViewHost link={link} takeover={viewed} ai={ai} online={online} inSession onMinimize={() => setViewing(null)} />}
				{changesOpen && (
					<ChangesPanel
						ai={ai}
						changes={changes}
						gitSupported={gitSupported}
						git={git}
						full={state.full}
						onFetchFull={fetchFull}
						onGitFileDiff={gitFileDiff}
						onClose={closeChanges}
					/>
				)}
			</div>
		</div>
	);
}

/**
 * The session's account ran out of usage and the machine knows one with
 * some left: one tap switches the whole machine to it.
 */
export function LimitBar({ from, to, left, onSwitch, ai }: { from: string; to: string; left: number; onSwitch: () => Promise<void>; ai: string }) {
	const t = useMachinesCopy();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	return (
		<section className="mx-limit" role="alert">
			<div className="mx-limit-inner">
				<MachineIcon name="gauge" />
				<p>{t.agent.limit.text(from, to, left)}</p>
				<button
					type="button"
					className="btn btn-sm btn-primary"
					disabled={busy}
					onClick={() => {
						setBusy(true);
						setError("");
						onSwitch().then(
							() => setBusy(false),
							(err: unknown) => {
								setBusy(false);
								setError(errorText(t, err, ai));
							},
						);
					}}
				>
					{t.agent.limit.action(to)}
				</button>
				{error !== "" && <p className="mx-error">{error}</p>}
			</div>
		</section>
	);
}

/** "⋯" of the session header: archive and delete (tunelo 2.0.6+), the machine, the folder, the encryption. */
function HeadMenu({
	machine,
	machineName,
	dir,
	manage,
}: {
	machine: string;
	machineName: string;
	dir: string;
	manage?: { link: MachineLink; thread: ThreadSummary; ai: string };
}) {
	const t = useMachinesCopy();
	const { open, setOpen, ref } = usePopover();
	const [deleting, setDeleting] = useState(false);
	return (
		<div className="mx-model" ref={ref}>
			<button type="button" className="icon-btn" aria-label={t.agent.header.menu} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
				<Icon name="dots" />
			</button>
			{open && (
				<div className="mx-menu" role="menu" aria-label={t.agent.header.menu}>
					{manage !== undefined && (
						<>
							<ThreadMenuItems link={manage.link} thread={manage.thread} onDelete={() => setDeleting(true)} onDone={() => setOpen(false)} />
							<hr />
						</>
					)}
					<Link to={paths.machineInfo(machine)} className="mx-menu-link">
						<MachineIcon name="monitor" small />
						<span>{t.agent.header.machine(machineName)}</span>
					</Link>
					{dir !== "" && (
						<p className="mx-menu-note">
							<MachineIcon name="folder" small />
							<span className="mono">{dir}</span>
						</p>
					)}
					<p className="mx-menu-note ok">
						<Icon name="lock" small />
						<span>{t.agent.header.e2ee}</span>
					</p>
				</div>
			)}
			{deleting && manage !== undefined && (
				<DeleteThreadDialog
					link={manage.link}
					thread={manage.thread}
					machine={machineName}
					ai={manage.ai}
					onClose={() => setDeleting(false)}
					onDeleted={() => navigate(paths.machines())}
				/>
			)}
		</div>
	);
}

interface DockProps {
	prompts: readonly Pending[];
	ai: string;
	sessionAllow: boolean;
	decide: (itemId: string, revision: number) => (decision: Decision, message?: string) => Promise<void>;
	answer: (itemId: string, revision: number) => (answers: string[][]) => Promise<void>;
}

/**
 * The AI waits for a sign-in secret: the oldest request, above the composer,
 * outside the transcript. The value goes to the machine in one frame.
 */
function SecretDock({ prompts, ai, link }: { prompts: readonly SecretPrompt[]; ai: string; link: MachineLink }) {
	const t = useMachinesCopy();
	const first = prompts[0];
	if (first === undefined) return null;
	const requestId = first.requestId;
	return (
		<section className="mx-dock" aria-label={t.secrets.title(ai)}>
			<div className="mx-dock-inner">
				<SecretCard
					key={requestId}
					prompt={first}
					ai={ai}
					onProvide={async (value, remember) => {
						await link.request({ case: "secretProvide", value: { requestId, value, remember } });
						link.dropSecretPrompt(requestId);
					}}
					onDecline={async () => {
						await link.request({ case: "secretDecline", value: { requestId } });
						link.dropSecretPrompt(requestId);
					}}
				/>
				{prompts.length > 1 && <p className="note">{t.secrets.more(prompts.length - 1)}</p>}
			</div>
		</section>
	);
}

/** The oldest prompt waiting for the user, above the composer; the count of those after it. */
function Dock({ prompts, ai, sessionAllow, decide, answer }: DockProps) {
	const t = useMachinesCopy();
	const first = prompts[0];
	if (first === undefined) return null;
	return (
		<section className="mx-dock" aria-label={t.agent.dock.label}>
			<div className="mx-dock-inner">
				{first.kind === "approval" ? (
					<ApprovalCard key={first.id} hotkeys approval={first.approval} ai={ai} sessionAllow={sessionAllow} onDecide={decide(first.id, first.revision)} />
				) : (
					<QuestionCard key={first.id} question={first.question} ai={ai} onAnswer={answer(first.id, first.revision)} />
				)}
				{prompts.length > 1 && <p className="note">{t.agent.dock.more(prompts.length - 1)}</p>}
			</div>
		</section>
	);
}

interface TranscriptProps {
	blocks: readonly Block[];
	state: LinkState;
	running: boolean;
	/** A prompt waits in the dock. */
	waiting: boolean;
	fetchFull: (itemId: string) => Promise<void>;
	link: UploadLink;
	threadId: string;
}

/** Within this distance of the bottom, the transcript follows new content. */
const STICK_PX = 80;

function Transcript({ blocks, state, running, waiting, fetchFull, link, threadId }: TranscriptProps) {
	const t = useMachinesCopy();
	const scroller = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	/** Blocks there were when the user scrolled up; null while following. */
	const [seenAt, setSeenAt] = useState<number | null>(null);
	const last = blocks.at(-1);
	const tail = last === undefined ? "" : `${blocks.length}:${last.kind === "text" ? last.text.length : last.id}`;
	// New content scrolls into view unless the user scrolled up to read.
	useEffect(() => {
		const el = scroller.current;
		if (el !== null && stick.current) el.scrollTop = el.scrollHeight;
	}, [tail]);
	// A width change (the changes panel, a rotated phone) keeps a following transcript at the bottom.
	const lastTop = useRef(0);
	useEffect(() => {
		const el = scroller.current;
		if (el === null || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => {
			if (stick.current) el.scrollTop = el.scrollHeight;
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	const typing = running && !waiting && !(last?.kind === "text" && last.partial);
	const newer = seenAt === null ? 0 : Math.max(0, blocks.length - seenAt);
	const toBottom = () => {
		const el = scroller.current;
		if (el === null) return;
		stick.current = true;
		setSeenAt(null);
		el.scrollTo?.({ top: el.scrollHeight, behavior: "smooth" });
		if (el.scrollTo === undefined) el.scrollTop = el.scrollHeight;
	};
	return (
		<div className="mx-messages-wrap">
			<div
				ref={scroller}
				className="mx-messages"
				onScroll={(event) => {
					const el = event.currentTarget;
					const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
					const up = el.scrollTop < lastTop.current;
					lastTop.current = el.scrollTop;
					if (atBottom) {
						stick.current = true;
						setSeenAt(null);
					} else if (up) {
						// Only the user scrolling up stops the following; content growing does not.
						stick.current = false;
						setSeenAt((seen) => seen ?? blocks.length);
					}
				}}
			>
				{blocks.length === 0 && !running && <p className="muted mx-center">{t.transcript.empty}</p>}
				{blocks.map((block) => (
					<BlockView key={block.id} block={block} state={state} running={running} fetchFull={fetchFull} t={t} link={link} threadId={threadId} />
				))}
				{typing && (
					<div className="mx-typing" role="status" aria-label={t.chat.typing(aiName(state.info, ""))}>
						<i />
						<i />
						<i />
					</div>
				)}
			</div>
			{seenAt !== null && (
				<button type="button" className="mx-jump" onClick={toBottom}>
					<Icon name="arrow-down" small />
					{t.agent.jump.newer}
					{newer > 0 && <span className="count">{newer}</span>}
				</button>
			)}
		</div>
	);
}

interface BlockViewProps {
	block: Block;
	state: LinkState;
	running: boolean;
	fetchFull: (itemId: string) => Promise<void>;
	t: MachinesCopy;
	link: UploadLink;
	threadId: string;
}

function BlockView({ block, state, running, fetchFull, t, link, threadId }: BlockViewProps) {
	const { locale } = useI18n();
	switch (block.kind) {
		case "user":
			return (
				<div className="mx-msg mine">
					<div className="bubble" aria-busy={block.pending}>
						{block.attachments.length > 0 && <MessageAttachments link={link} threadId={threadId} files={block.attachments} />}
						{block.text}
						{block.pending && <span className="sr-only">{t.chat.sending}</span>}
					</div>
				</div>
			);
		case "text":
			return <AgentText text={block.text} streaming={block.partial} />;
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
			// Answered (pending ones wait in the dock): the outcome line.
			return <ApprovalCard approval={block.approval} ai="" sessionAllow={false} onDecide={() => Promise.resolve()} />;
		case "question":
			return <QuestionCard question={block.question} ai="" onAnswer={() => Promise.resolve()} />;
		case "turn":
			return <TurnLine turn={block.turn} tools={block.tools} files={block.files} t={t} locale={locale} />;
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
