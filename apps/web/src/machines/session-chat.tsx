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
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { create } from "@bufbuild/protobuf";
import { AnswersSchema, Decision, PromptState, ThreadState, type MachineInfo, type SecretPrompt, type SlashCommand, type ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../components/screen-icons.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { Link, navigate, paths, useSearch } from "../router.tsx";
import { aiPaths } from "./ai-paths.ts";
import { AdvisorVerdictCard } from "./cards/advisor-verdict.tsx";
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
import { Composer, type FileListing, type ListFiles } from "./composer.tsx";
import type { MachinesCopy } from "./copy-vi.ts";
import type { LinkState, MachineLink } from "./link/machine-link.ts";
import { DeleteThreadDialog, ThreadMenuItems, threadActionsSupported } from "./thread-actions.tsx";
import { DiskAccessBanner } from "./disk-access-banner.tsx";
import { LinkBanner } from "./link-banner.tsx";
import { MachineIcon } from "./machine-icons.tsx";
import { profileById, sessionProfileId, switchPending, useProfiles } from "./machine-profile.ts";
import { PageHead } from "./page-head.tsx";
import { ProjectConfigHint } from "./project-config.tsx";
import { AgentText } from "./rich/agent-text.tsx";
import { leadingCommand } from "./slash-commands.ts";
import { StatusBar } from "./status-bar.tsx";
import { EMPTY_JOURNAL, orderedItems } from "./transcript/reducer.ts";
import { answeredModel, contextShare, currentModel, foldTranscript, turnRunning, turnStartedAt, type Block, type ShownAttachment } from "./transcript/tool-fold.ts";
import { messageCount, splitConversations } from "./transcript/conversation-break.ts";
import { aiName, errorText, folderName, modelName, providerOf, useEntry, useHub, useLink, useWatch } from "./use-machines.ts";
import { useAttachments } from "./use-attachments.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";
import { usePopover } from "./use-popover.ts";
import { AGENT_LIVE_ACTIVITY, versionAtLeast } from "./agent-version.ts";
import { ActivityLine, type ActivitySource } from "./activity-line.tsx";
import { BrowserDock, BrowserViewHost, ScreenViewHost } from "./browser/takeover-card.tsx";
import { ModeIcon, ModeSwitch, TerminalHeldBar, officeOffered, openSessionIn, rememberSessionMode, sessionModes, terminalOffered, type SessionMode } from "./session-mode.tsx";
import { PanelToggle, useWorkspacePanel, WorkspacePanelHost } from "./workspace/panel-toggle.tsx";
import { SessionPathPill, TerminalScreen } from "./terminal-screen.ts";
import { isPhone, useViewportFit } from "./viewport-fit.ts";
import { endOnPurpose } from "../terminal/ended-sessions.ts";
import { inFolder } from "./projects-view.ts";
import { useAgentProjects } from "./agent-projects-store.ts";
import { locate, threadStatus } from "./project-tree.ts";
import { useAdvisorScope, useAdvisorSession } from "../advisor/advisor-context.tsx";
import { useAdvisorIdentity } from "../advisor/use-advisor-identity.ts";
import { advisorStore, useSessionFill } from "../advisor/advisor-store.ts";

export { versionAtLeast };

/** The session's office (machines/office): loaded, with its styles and the building's layout, the first time it opens. */
const OfficeView = lazy(() => import("./office/office-view.tsx"));

/** The first tunelo that takes a message with a denial and lists a session's files. */
const AGENT_2_0_1 = [2, 0, 1] as const;

type Pending = Extract<Block, { kind: "approval" | "question" }>;

/**
 * Advisor's chips may send in this session: one the machine listed and not Advisor's own (before the list came,
 * an Advisor thread opened by its link is not known as one yet).
 */
export function verdictChipsSend(listed: boolean, advisorThread: boolean): boolean {
	return listed && !advisorThread;
}

function isPending(block: Block): block is Pending {
	return (block.kind === "approval" && block.approval.state === PromptState.PENDING) || (block.kind === "question" && block.question.state === PromptState.PENDING);
}

/** The office tab, with Advisor as the user's profile names and dresses it (the office draws Advisor while the session's automatic Advisor is on). */
function OfficeTab(props: { link: MachineLink; threadId: string; info: MachineInfo | null; online: boolean }) {
	const identity = useAdvisorIdentity();
	const advisor = useMemo(() => ({ name: identity.name, lookId: identity.look.id }), [identity.name, identity.look.id]);
	return <OfficeView {...props} advisor={advisor} />;
}

export function SessionChat({ machine, threadId, mode }: { machine: string; threadId: string; mode: SessionMode }) {
	const t = useMachinesCopy();
	const hub = useHub();
	const entry = useEntry(hub, machine);
	const [, projects] = useAgentProjects();
	const [link, state] = useLink(hub, machine);
	useWatch(link, threadId);
	const thread = state.threads.find((x) => x.id === threadId) ?? null;
	// `?tab=<id>`: one of the session's terminal tabs to bring to the front (its row in the AI Agent column).
	const pickedTab = new URLSearchParams(useSearch()).get("tab") || undefined;
	// Advisor's own thread ("Xem phiên Cố vấn"): read only here; questions go through the mascot, which names them.
	const advisorThread = state.advisorThreads.some((x) => x.id === threadId);
	const items = orderedItems(state.journals.get(threadId) ?? EMPTY_JOURNAL);
	// After the AI's CLI went on in another conversation (/clear), the session shows that one; earlier ones fold away.
	const conversations = splitConversations(items);
	const all = foldTranscript(conversations.current, state.pending.get(threadId) ?? []);
	const blocks = all.filter((b) => !isPending(b));
	const prompts = all.filter(isPending);
	// A long session opens on its newest items: until its oldest are in, the earlier conversations are counted in part.
	const allLoaded = (state.journals.get(threadId)?.earlier ?? "") === "";
	// An earlier conversation is over: Advisor's next steps there are spent.
	const previousBlocks = foldTranscript(conversations.previous)
		.filter((b) => !isPending(b))
		.map((b) => (b.kind === "advisor" ? { ...b, open: false } : b));
	// A prompt still pending in an earlier conversation shows in the dock: alone it makes no earlier conversation to fold.
	const previous: PreviousConversation | null =
		previousBlocks.length === 0
			? null
			: { blocks: previousBlocks, messages: allLoaded ? messageCount(conversations.previous) : null, breakId: conversations.breakId };
	/** The takeover whose live view shows over the session. */
	const [viewing, setViewing] = useState<string | null>(null);
	const viewed = viewing === null ? undefined : state.takeovers.get(viewing);
	/** The machine's whole screen shows over the session. */
	const [screenOpen, setScreenOpen] = useState(false);
	const openScreen = state.info?.screenShare === true ? () => setScreenOpen(true) : undefined;
	const provider = thread?.provider ?? items.at(-1)?.provider ?? "";
	const ai = aiName(state.info, provider);
	const caps = providerOf(state.info, provider)?.capabilities;
	// Sign-in secrets, browser takeovers and passkey notices come from tunelo's own MCP: only for an AI whose sessions take it.
	const mcp = caps?.sessionMcp === true;
	const secretPrompts = mcp ? [...state.secretPrompts.values()].filter((p) => p.threadId === threadId) : [];
	const takeovers = mcp ? [...state.takeovers.values()].filter((x) => x.threadId === threadId) : [];
	const passkeys = mcp ? state.passkeyNotices.filter((n) => n.threadId === threadId) : [];
	const outside = secretPrompts.length + takeovers.length;
	const online = state.status.kind === "open";
	const running = turnRunning(items) || thread?.state === ThreadState.RUNNING || thread?.state === ThreadState.WAITING || thread?.state === ThreadState.QUEUED;
	// What keeps the machine from opening the AI in a terminal: a turn (an approval waits inside one) or a queued
	// message. A question asked again after a restart is WAITING with no turn, and the terminal may open then.
	const turnHolds = turnRunning(items) || thread?.state === ThreadState.RUNNING || thread?.state === ThreadState.QUEUED;
	const threadInfo = state.threadInfo.get(threadId);
	const model = currentModel(items, thread?.model ?? "");
	const machineName = entry?.name ?? "";
	const missing = online && state.listed && thread === null && items.length === 0;
	const modern = versionAtLeast(state.info?.agentVersion ?? "", AGENT_2_0_1);
	const profiles = useProfiles(link, state.machineAccounts, online, provider);
	const profileId = sessionProfileId(state.machineAccounts, threadId, threadInfo, profiles.list);
	const pending = switchPending(state.machineAccounts, threadId, threadInfo);
	const nextProfile = profileById(profiles.list, profiles.list?.selectedId ?? "");
	const switchingTo = !pending ? "" : threadInfo?.nextAccount?.email || nextProfile?.email || t.agent.account.defaultName;
	const suggestion = pending ? undefined : threadInfo?.accountSuggestion;
	const limits = limitsOf(state.info?.attachments);
	const attach = useAttachments(link, threadId, limits, caps?.images ?? false, ai);
	// In the terminal the dock takes dropped files itself (into the session's folder, the path typed in the pane).
	const drop = useFileDrop(online && !missing && mode === "chat", (files) => {
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

	// The header stays lean: only "offline" has a chip there. Waiting and running show in the conversation (the
	// approval card, the live activity), and the terminal's pill and "Kết thúc" say when the terminal holds it.
	const chip = online ? null : "offline";
	const dir = thread?.dir ?? "";
	const offered = terminalOffered(state.info, provider);
	// The views of the session's header: the switch shows once there are two.
	const modes = sessionModes(offered, officeOffered(state.info), mode);
	// The workspace panel (Explorer, Source Control) of the machine's project holding the folder.
	const panel = useWorkspacePanel(machine, link, state, dir);
	const panelShown = panel.prefs.open && panel.workspace !== undefined && thread !== null;
	const toTerminal = offered && mode === "chat" && thread !== null
		? () => openSessionIn(machine, threadId, "terminal")
		: undefined;
	const workspacePanel = panelShown && panel.workspace !== undefined && (
		<WorkspacePanelHost
			link={link}
			workspace={{ id: panel.workspace.id, name: panel.workspace.name || folderName(panel.workspace.dir), dir: panel.workspace.dir }}
			online={online}
			ai={ai}
			writer={caps?.commitMessage === true ? provider : undefined}
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
	const canSend = online && !missing && !held;
	const send = async (text: string, files: readonly ShownAttachment[]): Promise<void> => {
		// `/clear` opens a new, empty session in this folder: go to it.
		const opened = await link.send(threadId, text, files);
		if (opened !== undefined) navigate(paths.machineSession(machine, opened.id));
	};
	// "project · workspace · branch · machine" under the title: the project holding the session's folder, else the folder.
	const placed = entry === null || dir === "" ? null : locate(projects.projects, entry.id, dir);
	const own = state.projects?.projects.filter((x) => inFolder(dir, x.dir)).sort((a, b) => b.dir.length - a.dir.length)[0];
	const branch = own?.git?.git === true ? own.git.branch : (placed?.workspace.branch ?? "");
	const workspace = placed === null ? folderName(dir) : folderName(placed.workspace.dir);
	// Copies made in the session (its transcript, terminal, Source Control) tell Advisor where; the mascot's menu follows it.
	useAdvisorScope(chatRef, { screen: "session", machine, threadId, dir, branch });
	useAdvisorSession(machine, threadId);
	// "Gửi sang phiên": Advisor's pick waits in the composer for the user to send.
	const fill = useSessionFill(machine, threadId);
	const endTerminal = held
		? () => {
				endOnPurpose(machine, thread.terminalSession);
				return link.request({ case: "termClose", value: { session: thread.terminalSession } }).then(() => undefined);
			}
		: undefined;
	return (
		<div className="mx-chat" ref={chatRef} data-mode={mode} {...drop.handlers}>
			{drop.dragging && <DropZone ai={ai} maxBytes={limits?.fileMaxBytes ?? 0} supported={limits !== null} />}
			<PageHead
				back={paths.machines()}
				backLabel={t.backToMachines}
				title={thread ? thread.title || t.agent.newSession : ""}
				subtitle={
					<>
						{thread !== null && (
							// The path pill sits under the title on every view, so switching views keeps it in place.
							<span className="mx-sub-pill">
								<Suspense fallback={null}>
									<SessionPathPill machine={machine} terminal={offered} />
								</Suspense>
							</span>
						)}
						<span className="mono" title={dir}>
							{placed?.project.name ?? workspace}
						</span>
						{branch !== "" && <span className="hide-narrow">· {branch}</span>}
						{thread !== null && mode === "chat" && (
							// The workspace's folder when the session is in one, so its switch shows the same level.
							<ProjectConfigHint key={threadId} link={link} level={thread.projectConfig} dir={own?.dir ?? dir} ai={ai} online={online} />
						)}
					</>
				}
			>
				<ModeSwitch machine={machine} threadId={threadId} mode={mode} modes={modes} />
				{chip !== null && (
					<span className={`chip mx-chip ${chip}`} role="status" aria-label={t.chat.chip[chip]} title={t.chat.chip[chip]}>
						<span className="hide-narrow" aria-hidden="true">
							{t.chat.chip[chip]}
						</span>
					</span>
				)}
				{thread !== null && <PanelToggle panel={panel} />}
				<HeadMenu
					machine={machine}
					machineName={machineName}
					dir={dir}
					narrowItems={(close) => (
						<>
							{modes.length > 1 &&
								modes
									.filter((m) => m !== mode)
									.map((m) => (
										<button key={m} type="button" role="menuitem" onClick={() => {
											close();
											openSessionIn(machine, threadId, m);
										}}>
											<ModeIcon mode={m} />
											<span>{t.terminal.mode[m]}</span>
										</button>
									))}
							{thread !== null && panel.workspace !== undefined && (
								<button type="button" role="menuitem" onClick={() => {
									close();
									panel.toggle();
								}}>
									<MachineIcon name="folder" small />
									<span>{t.agent.header.panel}</span>
								</button>
							)}
						</>
					)}
					{...(thread !== null && online && threadActionsSupported(state.info) ? { manage: { link, thread, ai, info: state.info } } : {})}
					{...(endTerminal !== undefined && online ? { endTerminal } : {})}
				/>
			</PageHead>
			<LinkBanner machine={machine} name={machineName} status={state.status} />
			<DiskAccessBanner machine={machine} link={link} info={state.info} online={online} bar />
			{mode === "office" ? (
				<div className="mx-chat-body">
					<Suspense fallback={<p className="mx-group-note muted">{t.office.loading}</p>}>
						<OfficeTab link={link} threadId={threadId} info={state.info} online={online} />
					</Suspense>
					{workspacePanel}
				</div>
			) : mode === "terminal" ? (
				<div className="mx-chat-body">
					{offered && thread !== null ? (
						<Suspense fallback={<p className="mx-group-note muted">{t.terminal.loading}</p>}>
							<TerminalScreen
								machine={machine}
								thread={{ id: threadId, dir: thread.dir, chat: paths.machineSession(machine, threadId), running: turnHolds, inTerminal: thread.terminalSession !== 0, status: threadStatus(thread, false), provider: thread.provider, aiName: ai }}
								showTab={pickedTab}
								// The tab is in front: the address goes back to the session's terminal.
								onTabShown={() => navigate(aiPaths.sessionTerminal(machine, threadId), { replace: true })}
							/>
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
							previous={previous}
							state={state}
							running={running}
							startedAt={turnStartedAt(items)}
							waiting={prompts.length > 0 || outside > 0}
							fetchFull={fetchFull}
							link={link}
							threadId={threadId}
							thread={thread}
							live={versionAtLeast(state.info?.agentVersion ?? "", AGENT_LIVE_ACTIVITY)}
							older={!allLoaded}
							breakId={conversations.breakId}
							loadOlder={() => link.loadEarlier(threadId)}
							onSend={verdictChipsSend(state.listed, advisorThread) ? (text) => send(text, []) : undefined}
							sendLocked={!canSend}
							commands={threadInfo?.commands}
						/>
					)}
					{suggestion !== undefined && (
						<LimitBar
							from={profileName(t, profileById(profiles.list, profileId), threadInfo?.account?.email ?? "")}
							to={suggestion.email}
							left={suggestion.remaining}
							onSwitch={() => profiles.request({ case: "accountSelect", value: { id: suggestion.accountId, provider: suggestion.provider || provider } })}
							ai={ai}
						/>
					)}
					{secretPrompts.length > 0 && <SecretDock prompts={secretPrompts} ai={ai} link={link} />}
					{(takeovers.length > 0 || passkeys.length > 0) && <BrowserDock link={link} takeovers={takeovers} notices={passkeys} ai={ai} onView={setViewing} onScreen={openScreen} />}
					{prompts.length > 0 && (
						<Dock prompts={prompts} ai={ai} sessionAllow={caps?.sessionAllow ?? false} decide={decide} answer={answer} />
					)}
					{held && <TerminalHeldBar machine={machine} link={link} thread={thread} ai={ai} />}
					<div className="mx-compose-box">
					{!missing && !advisorThread && (
						<StatusBar
							ai={ai}
							dir={dir}
							machine={state.info}
							provider={provider}
							model={model}
							answered={answeredModel(items)}
							context={contextShare(conversations.current)}
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
					{!advisorThread && (
					<Composer
						ai={ai}
						machine={machineName}
						online={canSend}
						running={running}
						prompting={prompts.length > 0 || outside > 0}
						commands={threadInfo?.commands ?? []}
						listFiles={modern ? listFiles : undefined}
						attach={attach}
						focusKey={threadId}
						fill={fill}
						onFilled={(id) => advisorStore.takeFill(machine, threadId, id)}
						onSend={send}
						onStop={async () => {
							await link.request({ case: "threadInterrupt", value: { threadId } });
						}}
					/>
					)}
					</div>
				</div>
				{screenOpen && <ScreenViewHost link={link} ai={ai} online={online} inSession onClose={() => setScreenOpen(false)} />}
				{viewed !== undefined && <BrowserViewHost link={link} takeover={viewed} ai={ai} online={online} inSession onMinimize={() => setViewing(null)} />}
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
				<div className="mx-limit-acts">
					<button
						type="button"
						className="btn btn-sm btn-primary"
						disabled={busy}
						aria-label={t.agent.limit.action(to)}
						title={t.agent.limit.action(to)}
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
						{t.agent.limit.short}
					</button>
				</div>
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
	narrowItems,
	manage,
	endTerminal,
}: {
	machine: string;
	machineName: string;
	dir: string;
	/**
	 * On a phone the header shows only the title and this menu: the mode and the panel come here.
	 * Each item closes the menu itself (`close`) when tapped.
	 */
	narrowItems?: (close: () => void) => ReactNode;
	manage?: { link: MachineLink; thread: ThreadSummary; ai: string; info: MachineInfo | null };
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
					{narrowItems !== undefined && (
						// Not closed on the click's capture: that unmounts the menu before a real tap reaches the item.
						<div className="mx-menu-narrow">
							{narrowItems(() => setOpen(false))}
							<hr />
						</div>
					)}
					{manage !== undefined && (
						<>
							<ThreadMenuItems link={manage.link} thread={manage.thread} info={manage.info} onDelete={() => setDeleting(true)} onDone={() => setOpen(false)} />
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
					machineRef={machine}
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

/** The conversations before the latest break (the AI's CLI went on in another one): folded away until asked for. */
export interface PreviousConversation {
	readonly blocks: readonly Block[];
	/** Messages of the user and the AI in them; null while older items of the session are still on the machine. */
	readonly messages: number | null;
	/** The latest break: another one means the CLI went on in yet another conversation. */
	readonly breakId: string;
}

interface TranscriptProps {
	/** The conversation the session is in now. */
	blocks: readonly Block[];
	previous?: PreviousConversation | null;
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
	/** The machine holds older items of the session than this device loaded (it sent the newest first). */
	older?: boolean;
	/**
	 * The session's latest conversation break ("" when none), known before any item of an earlier conversation is
	 * loaded: paging those in must not count as the CLI going on in another conversation.
	 */
	breakId?: string;
	/** Asks the machine for the page before the loaded items; resolves once it is in or failed. */
	loadOlder?: () => Promise<void>;
	/**
	 * Sends a message to the session (an Advisor verdict's chip); none where the user sends nothing (Advisor's own
	 * session, or before the machine listed its threads and that is not known yet).
	 */
	onSend?: ((text: string) => Promise<void>) | undefined;
	/** The session cannot take a message now (offline, held by its terminal): chips are dimmed like during a turn. */
	sendLocked?: boolean;
	/** The AI's commands and skills, so a sent "/skill" stands out; none while unknown. */
	commands?: readonly SlashCommand[] | undefined;
}

/**
 * Where the user is reading: the first block on screen and how far below the top of the transcript it shows. A
 * running session adds blocks at the bottom while older ones load above, so the height that changed is not all
 * above the reading position; the block itself is.
 */
interface ReadingMark {
	readonly node: Element | null;
	readonly offset: number;
	/** The scroll height, for when the block is gone. */
	readonly height: number;
}

/** The buttons above the blocks stay at the top whatever loads: never a reading position. */
const NOT_A_BLOCK = "[data-id=transcript-older], [data-id=transcript-earlier], [data-id=transcript-previous]";

export function markReading(el: HTMLElement): ReadingMark {
	const top = el.getBoundingClientRect().top;
	const blocks = [...el.children].filter((c) => !c.matches(NOT_A_BLOCK));
	// The first block may fold together with what loads above it (a run of tools grows into an earlier one and is
	// drawn anew): any later one keeps its element.
	const later = blocks.slice(1);
	const node = later.find((c) => c.getBoundingClientRect().bottom > top) ?? blocks[0] ?? null;
	return { node, offset: node === null ? 0 : node.getBoundingClientRect().top - top, height: el.scrollHeight };
}

export function keepReading(el: HTMLElement, mark: ReadingMark): void {
	// The block still in this transcript (React kept its element): it goes back where it was on screen.
	if (mark.node !== null && el.contains(mark.node)) el.scrollTop += mark.node.getBoundingClientRect().top - el.getBoundingClientRect().top - mark.offset;
	else el.scrollTop += el.scrollHeight - mark.height;
}

/** Within this distance of the bottom, the transcript follows new content. */
const STICK_PX = 80;
/** Blocks drawn when a session opens; scrolling near the top draws this many more. */
export const TRANSCRIPT_PAGE = 40;
/** How near the top (px) scrolling starts drawing earlier blocks. */
const EARLIER_PX = 600;

/** The messages of the session, then the activity line while a turn runs (its clock ticks there, not here). */
const NO_COMMANDS: readonly SlashCommand[] = [];

export function Transcript({ blocks, previous = null, state, running, startedAt, waiting, fetchFull, link, threadId, thread, live, older = false, loadOlder, breakId, onSend, sendLocked = false, commands = NO_COMMANDS }: TranscriptProps) {
	const t = useMachinesCopy();
	const scroller = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	/** Blocks there were when the user scrolled up; null while following. */
	const [seenAt, setSeenAt] = useState<number | null>(null);
	// A long session opens on its last blocks only (drawing hundreds took seconds on a slower device); earlier ones
	// come in pages as the user scrolls up. While following, the window is the last page; once the user scrolls up
	// its first block stays put, so blocks arriving meanwhile never shift what is being read.
	// The window and the opened earlier conversations belong to one conversation of the session: when the CLI goes
	// on in another one (/clear), the current one starts over, shorter than the window kept for the one before.
	const view = `${threadId}\u0000${breakId ?? previous?.breakId ?? ""}`;
	const [from, setFrom] = useState<{ view: string; start: number | null }>({ view, start: null });
	// The earlier conversations, once opened, come before the current one and page like it; the row that opens
	// and closes them stays where the current one begins.
	const [openedFor, setOpenedFor] = useState<string | null>(null);
	const opened = previous !== null && openedFor === view;
	const before = opened ? previous.blocks.length : 0;
	const all = opened ? [...previous.blocks, ...blocks] : blocks;
	const fixed = from.view === view && from.start !== null && from.start < all.length ? from.start : null;
	const start = fixed ?? Math.max(0, all.length - TRANSCRIPT_PAGE);
	const shown = start > 0 ? all.slice(start) : all;
	const togglePrevious = () => {
		if (previous === null) return;
		const n = previous.blocks.length;
		// Opened: the last page of the earlier conversations shows above the row, read down into the current one.
		// Closed: the window keeps its place in the current conversation.
		if (opened) setFrom({ view, start: fixed === null ? null : Math.max(0, fixed - n) });
		else setFrom({ view, start: Math.max(0, n - TRANSCRIPT_PAGE) });
		setOpenedFor(opened ? null : view);
	};
	/** Where the user was reading before earlier blocks came in: the reading position is kept across them. */
	const heightBefore = useRef<ReadingMark | null>(null);
	useLayoutEffect(() => {
		const el = scroller.current;
		if (el === null || heightBefore.current === null) return;
		keepReading(el, heightBefore.current);
		heightBefore.current = null;
		// Every window change clears the mark, also one that ends where it began: a mark left behind would ignore
		// every later reach of the top.
	}, [start, from]);
	// Older items still on the machine: fetched when the user reaches the top of what is loaded. The first block tells
	// when they came in; the block being read keeps its place on screen across the blocks they add above it.
	const firstId = all[0]?.id;
	const [fetching, setFetching] = useState(false);
	const olderAnchor = useRef<{ mark: ReadingMark; firstId: string | undefined } | null>(null);
	useLayoutEffect(() => {
		const el = scroller.current;
		const anchor = olderAnchor.current;
		if (el === null || anchor === null || anchor.firstId === firstId) return;
		keepReading(el, anchor.mark);
		olderAnchor.current = null;
	}, [firstId]);
	useLayoutEffect(() => {
		// The page is in but added nothing above (it went to a folded earlier conversation): nothing to keep.
		if (!fetching) olderAnchor.current = null;
	}, [fetching]);
	// Folded earlier conversations take what comes before them without being drawn: page them only once opened.
	const canFetchOlder = older && loadOlder !== undefined && (previous === null || opened);
	const fetchOlder = () => {
		if (!canFetchOlder || fetching) return;
		const el = scroller.current;
		olderAnchor.current = el === null ? null : { mark: markReading(el), firstId };
		setFetching(true);
		void loadOlder().finally(() => setFetching(false));
	};
	const showEarlier = () => {
		const el = scroller.current;
		if (heightBefore.current !== null) return;
		if (start === 0) {
			fetchOlder();
			return;
		}
		heightBefore.current = el === null ? null : markReading(el);
		// From the window as it is by now: scroll events can come faster than renders, and this render's `start` may
		// already be stale.
		setFrom((f) => {
			const current = f.view === view && f.start !== null && f.start < all.length ? f.start : start;
			return { view, start: Math.max(0, current - TRANSCRIPT_PAGE) };
		});
	};
	const last = blocks.at(-1);
	const tail = last === undefined ? "" : `${blocks.length}:${last.kind === "text" ? last.text.length : last.id}`;
	// New content scrolls into view unless the user scrolled up to read.
	useEffect(() => {
		const el = scroller.current;
		if (el !== null && stick.current) el.scrollTop = el.scrollHeight;
	}, [tail]);
	// The CLI went on in another conversation while the user read further up: the new one shows from its end.
	const shownView = useRef(view);
	useEffect(() => {
		if (shownView.current === view) return;
		shownView.current = view;
		stick.current = true;
		setSeenAt(null);
		const el = scroller.current;
		if (el !== null) el.scrollTop = el.scrollHeight;
	}, [view]);
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
						// Pins the window where it is unless an earlier event of this burst moved it already.
						if (fixed === null) setFrom((f) => (f.view === view && f.start !== null ? f : { view, start }));
					}
					// The user keeps scrolling (a phone's fling) while an older page loads: it keeps their latest place.
					if (olderAnchor.current !== null) olderAnchor.current = { ...olderAnchor.current, mark: markReading(el) };
					if (up && el.scrollTop < EARLIER_PX) showEarlier();
				}}
			>
				{start > 0 ? (
					<button type="button" className="btn btn-sm mx-earlier" onClick={showEarlier} data-id="transcript-earlier">
						{t.transcript.earlier(Math.min(start, TRANSCRIPT_PAGE))}
					</button>
				) : (
					canFetchOlder && (
						<button type="button" className="btn btn-sm mx-earlier" onClick={fetchOlder} disabled={fetching} aria-busy={fetching} data-id="transcript-older">
							{fetching ? t.transcript.loadingOlder : t.transcript.older}
						</button>
					)
				)}
				{withPreviousRow(
					shown.map((block) => (
						<BlockView
							key={block.id}
							block={block}
							state={state}
							running={running || (block.kind === "tools" && block === last)}
							fetchFull={fetchFull}
							t={t}
							link={link}
							threadId={threadId}
							ai={aiName(state.info, thread?.provider ?? "")}
							onSend={onSend}
							sendLocked={sendLocked}
							commands={commands}
						/>
					)),
					previous === null || before < start ? null : (
						<PreviousRow key="previous-conversation" messages={previous.messages} opened={opened} onToggle={togglePrevious} t={t} />
					),
					before - start,
				)}
				{blocks.length === 0 && !running && <p className="muted mx-center">{t.transcript.empty}</p>}
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

/** The drawn blocks with the earlier conversations' row placed at `at` (where the current conversation begins); none when off the window. */
function withPreviousRow(views: ReactNode[], row: ReactNode, at: number): ReactNode[] {
	if (row === null) return views;
	return [...views.slice(0, at), row, ...views.slice(at)];
}

/** One small row where the current conversation begins: "Cuộc trò chuyện trước (n tin nhắn)", opening the earlier ones above it. */
function PreviousRow({ messages, opened, onToggle, t }: { messages: number | null; opened: boolean; onToggle: () => void; t: MachinesCopy }) {
	return (
		<button type="button" className="mx-previous" aria-expanded={opened} onClick={onToggle} data-id="transcript-previous">
			<MachineIcon name="chevron-right" small />
			<span>{messages === null ? t.transcript.previousUncounted : t.transcript.previous(messages)}</span>
		</button>
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
	ai: string;
	onSend: ((text: string) => Promise<void>) | undefined;
	sendLocked: boolean;
	commands: readonly SlashCommand[];
}

function BlockView({ block, state, running, fetchFull, t, link, threadId, ai, onSend, sendLocked, commands }: BlockViewProps) {
	const { locale } = useI18n();
	switch (block.kind) {
		case "user": {
			// The files sit above the bubble on the user's side; a "/skill" the message starts with stands out.
			const command = leadingCommand(block.text, commands);
			return (
				<div className="mx-msg mine" aria-busy={block.pending}>
					{block.attachments.length > 0 && <MessageAttachments link={link} threadId={threadId} files={block.attachments} />}
					{block.text !== "" && (
						<div className="bubble">
							{command > 0 && <span className="mx-skill">{block.text.slice(0, command)}</span>}
							{block.text.slice(command)}
						</div>
					)}
					{block.pending && <span className="sr-only">{t.chat.sending}</span>}
				</div>
			);
		}
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
		case "advisor":
			// Chips wait for the turn to end (one sent mid-turn would land in the wrong turn) and are spent once anything followed.
			return <AdvisorVerdictCard verdict={block.verdict} onSend={onSend} past={!block.open} running={running} unavailable={sendLocked} ai={ai} />;
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
