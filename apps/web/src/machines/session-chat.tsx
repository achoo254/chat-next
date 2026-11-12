// One AI session (thread) of a machine: a short header (title, folder,
// state, "Thay đổi", a menu with the machine and the encryption), the
// transcript (markdown answers, tool rows, diffs, todos, results of answered
// prompts), the prompts waiting for the user docked above the composer, the
// status bar and the composer. "Thay đổi" opens what changed in the folder
// (git, tunelo 2.0.11+) and the files the AI edited.
// The thread is watched on the machine's shared link while this shows, so a
// reconnect resubscribes from the cursor and a reset reloads the snapshot.
// Files dragged anywhere over the session go to the composer when dropped.
// "Chat | Terminal" in the header opens the same session in its AI's own CLI
// instead (session-mode.tsx); while the CLI holds it, the chat is read-only.
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
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
import { ProjectConfigHint } from "./project-config.tsx";
import { AgentText } from "./rich/agent-text.tsx";
import { StatusBar } from "./status-bar.tsx";
import { sessionChanges } from "./transcript/changes.ts";
import { EMPTY_JOURNAL, orderedItems } from "./transcript/reducer.ts";
import { contextShare, currentModel, foldTranscript, turnRunning, turnStartedAt, type Block } from "./transcript/tool-fold.ts";
import { aiName, errorText, folderName, isRunning, modelName, providerOf, stateKey, useEntry, useHub, useLink, useWatch } from "./use-machines.ts";
import { useAttachments } from "./use-attachments.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";
import { usePopover } from "./use-popover.ts";
import { AGENT_LIVE_ACTIVITY, versionAtLeast } from "./agent-version.ts";
import { ActivityLine, type ActivitySource } from "./activity-line.tsx";
import { BrowserDock, BrowserViewHost, ScreenViewHost } from "./browser/takeover-card.tsx";
import { ModeSwitch, TerminalHeldBar, rememberMode, rememberSessionMode, terminalOffered, type SessionMode } from "./session-mode.tsx";
import { aiPaths } from "./ai-paths.ts";
import { PanelToggle, useWorkspacePanel, WorkspacePanelHost } from "./workspace/panel-toggle.tsx";
import { TerminalPill, TerminalScreen } from "./terminal-screen.ts";
import { isPhone, useViewportFit } from "./viewport-fit.ts";
import { endOnPurpose } from "../terminal/ended-sessions.ts";
import { inFolder } from "./projects-view.ts";
import { useAgentProjects } from "./agent-projects-store.ts";
import { locate } from "./project-tree.ts";

export { versionAtLeast };

/** The first tunelo that takes a message with a denial and lists a session's files. */
const AGENT_2_0_1 = [2, 0, 1] as const;

type Pending = Extract<Block, { kind: "approval" | "question" }>;

function isPending(block: Block): block is Pending {
	return (block.kind === "approval" && block.approval.state === PromptState.PENDING) || (block.kind === "question" && block.question.state === PromptState.PENDING);
}

export function SessionChat({ machine, threadId, mode }: { machine: string; threadId: string; mode: SessionMode }) {
	const t = useMachinesCopy();
	const hub = useHub();
	const entry = useEntry(hub, machine);
	const [, projects] = useAgentProjects();
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
		document.querySelector<HTMLElement>(".mx-chat [data-composer]")?.focus();
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

	// Held by a terminal of the machine's own (TermOpen of the AI): it runs in the terminal, not "elsewhere".
	// In the terminal its pill and "Kết thúc" already say it runs there, and the banner says when another process has the session open; in chat the chip says why it is read-only.
	const chip = !online ? "offline" : thread === null ? null : thread.terminalSession > 0 ? (mode === "terminal" ? null : isRunning(thread) ? "terminal" : "terminalOpen") : mode === "terminal" && stateKey(thread) === "elsewhere" ? null : stateKey(thread);
	const dir = thread?.dir ?? "";
	const offered = terminalOffered(state.info, provider);
	// The workspace panel (Explorer, Source Control) of the machine's project holding the folder.
	const panel = useWorkspacePanel(machine, link, state, dir);
	const panelShown = panel.prefs.open && panel.workspace !== undefined && thread !== null;
	const toTerminal = offered && mode === "chat" && thread !== null
		? () => {
				rememberMode(machine, "terminal");
				navigate(aiPaths.sessionTerminal(machine, threadId));
			}
		: undefined;
	const workspacePanel = panelShown && panel.workspace !== undefined && (
		<WorkspacePanelHost
			link={link}
			workspace={{ id: panel.workspace.id, name: panel.workspace.name || folderName(panel.workspace.dir), dir: panel.workspace.dir }}
			online={online}
			ai={ai}
			prefs={panel.prefs}
			onPrefs={panel.update}
			onTerminal={toTerminal}
		/>
	);
	// On a phone the session keeps to what the keyboard leaves: header on top, composer (or key bar) at the bottom.
	const chatRef = useRef<HTMLDivElement>(null);
	const [phone] = useState(isPhone);
	useViewportFit(chatRef, phone);
	useEffect(() => rememberSessionMode(machine, threadId, mode), [machine, threadId, mode]);
	// The session's AI runs in the machine's terminal: only the terminal writes to it.
	const held = thread !== null && thread.terminalSession > 0;
	// "project · workspace · branch · machine" under the title: the project holding the session's folder, else the folder.
	const placed = entry === null || dir === "" ? null : locate(projects.projects, entry.id, dir);
	const own = state.projects?.projects.filter((x) => inFolder(dir, x.dir)).sort((a, b) => b.dir.length - a.dir.length)[0];
	const branch = own?.git?.git === true ? own.git.branch : (placed?.workspace.branch ?? "");
	const workspace = placed === null ? folderName(dir) : folderName(placed.workspace.dir);
	const endTerminal = held
		? () => {
				endOnPurpose(machine, thread.terminalSession);
				return link.request({ case: "termClose", value: { session: thread.terminalSession } }).then(() => undefined);
			}
		: undefined;
	return (
		<div className="mx-chat" ref={chatRef} data-mode={mode} data-changes={changesOpen ? "open" : undefined} {...drop.handlers}>
			{drop.dragging && <DropZone ai={ai} maxBytes={limits?.fileMaxBytes ?? 0} supported={limits !== null} />}
			<PageHead
				back={paths.machines()}
				backLabel={t.backToMachines}
				title={thread ? thread.title || t.agent.newSession : ""}
				subtitle={
					<>
						<span className="mono" title={dir}>
							{placed?.project.name ?? workspace}
						</span>
						{placed !== null && placed.project.name !== workspace && <span className="hide-narrow">· {workspace}</span>}
						{branch !== "" && <span className="hide-narrow">· {branch}</span>}
						<span className="hide-narrow">· {machineName}</span>
						{thread !== null && mode === "chat" && (
							// The workspace's folder when the session is in one, so its switch shows the same level.
							<ProjectConfigHint key={threadId} link={link} level={thread.projectConfig} dir={own?.dir ?? dir} ai={ai} online={online} />
						)}
					</>
				}
			>
				{offered && <ModeSwitch machine={machine} threadId={threadId} mode={mode} />}
				{mode === "terminal" && offered && (
					<Suspense fallback={null}>
						<TerminalPill machine={machine} />
					</Suspense>
				)}
				{mode === "terminal" && endTerminal !== undefined && (
					<button type="button" className="btn btn-sm" title={t.terminal.endHint} onClick={() => void endTerminal().catch(() => undefined)} data-id="session-terminal-end-btn">
						{t.terminal.end}
					</button>
				)}
				{chip !== null && (
					<span className={`chip mx-chip ${chip}`} role="status" aria-label={t.chat.chip[chip]} title={t.chat.chip[chip]}>
						<span className="hide-narrow" aria-hidden="true">
							{t.chat.chip[chip]}
						</span>
					</span>
				)}
				{thread !== null && mode === "chat" && (
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
				{thread !== null && <PanelToggle panel={panel} />}
				<HeadMenu
					machine={machine}
					machineName={machineName}
					dir={dir}
					{...(thread !== null && online && threadActionsSupported(state.info) ? { manage: { link, thread, ai } } : {})}
					{...(endTerminal !== undefined && online ? { endTerminal } : {})}
				/>
			</PageHead>
			<LinkBanner machine={machine} name={machineName} status={state.status} />
			<DiskAccessBanner machine={machine} link={link} info={state.info} online={online} bar />
			{mode === "terminal" ? (
				<div className="mx-chat-body">
					{offered && thread !== null ? (
						<Suspense fallback={<p className="mx-group-note muted">{t.terminal.loading}</p>}>
							<TerminalScreen machine={machine} thread={{ id: threadId, dir: thread.dir, chat: paths.machineSession(machine, threadId) }} />
						</Suspense>
					) : (
						<p className="note mx-group-note" role="status">
							{state.info === null || thread === null ? t.terminal.loading : t.terminal.offerFailed}
						</p>
					)}
					{workspacePanel}
				</div>
			) : (
			<div className="mx-chat-body">
				<div className="mx-chat-main">
					{missing ? (
						<div className="empty">
							<p>{t.chat.notFound}</p>
						</div>
					) : (
						<Transcript
							blocks={blocks}
							state={state}
							running={running}
							startedAt={turnStartedAt(items)}
							waiting={prompts.length > 0 || outside > 0}
							fetchFull={fetchFull}
							link={link}
							threadId={threadId}
							thread={thread}
							live={versionAtLeast(state.info?.agentVersion ?? "", AGENT_LIVE_ACTIVITY)}
						/>
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
					{held && <TerminalHeldBar machine={machine} link={link} thread={thread} ai={ai} />}
					<Composer
						ai={ai}
						machine={machineName}
						online={online && !missing && !held}
						running={running}
						prompting={prompts.length > 0 || outside > 0}
						commands={threadInfo?.commands ?? []}
						listFiles={modern ? listFiles : undefined}
						attach={attach}
						focusKey={threadId}
						onSend={async (text, files) => {
							// `/clear` opens a new, empty session in this folder: go to it.
							const opened = await link.send(threadId, text, files);
							if (opened !== undefined) navigate(paths.machineSession(machine, opened.id));
						}}
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
				{workspacePanel}
			</div>
			)}
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
	endTerminal,
}: {
	machine: string;
	machineName: string;
	dir: string;
	manage?: { link: MachineLink; thread: ThreadSummary; ai: string };
	/** The session's AI runs in the terminal: "Kết thúc" stops it there. */
	endTerminal?: () => Promise<void>;
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
					{endTerminal !== undefined && (
						<>
							<button
								type="button"
								role="menuitem"
								className="danger"
								title={t.terminal.endHint}
								onClick={() => {
									setOpen(false);
									endTerminal().catch(() => undefined);
								}}
								data-id="session-terminal-end"
							>
								<MachineIcon name="terminal" small />
								<span>{t.terminal.endHint}</span>
							</button>
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
	/** When the running turn began (Unix ms); null when none runs. */
	startedAt: number | null;
	/** A prompt waits in the dock. */
	waiting: boolean;
	fetchFull: (itemId: string) => Promise<void>;
	link: UploadLink & ActivitySource;
	threadId: string;
	thread: ThreadSummary | null;
	/** The machine tells what a running turn does (ThreadActivity). */
	live: boolean;
}

/** Within this distance of the bottom, the transcript follows new content. */
const STICK_PX = 80;

/** The messages of the session, then the activity line while a turn runs (its clock ticks there, not here). */
export function Transcript({ blocks, state, running, startedAt, waiting, fetchFull, link, threadId, thread, live }: TranscriptProps) {
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
					<BlockView key={block.id} block={block} state={state} running={running || (block.kind === "tools" && block === last)} fetchFull={fetchFull} t={t} link={link} threadId={threadId} />
				))}
				<ActivityLine
					source={link}
					threadId={threadId}
					thread={thread}
					running={running}
					live={live}
					startedAt={startedAt}
					waiting={waiting}
					streaming={last?.kind === "text" && last.partial}
					ai={aiName(state.info, thread?.provider ?? "")}
				/>
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
