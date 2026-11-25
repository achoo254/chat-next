// A tool waiting for the user's permission: Allow, Allow for the session (not
// for a sensitive path, nor when the AI cannot remember it), Deny and tell
// the AI what to do instead, Deny. In a session the card sits above the
// composer and answers keys 1, 2, 3 and Esc. The answer names the revision
// the user saw, so a prompt that changed meanwhile is refused instead of
// answered blindly. An answered prompt shows in its tool's row
// (tool-run.tsx); one without a shown tool stays as a short line. A tool
// that acts as the user (ApprovalItem.write: a message into a chat, a
// Localman request, a tunnel) is worded here in the user's language, the
// chat named as this device knows it; older machines send only English.
import { useCallback, useContext, useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import { PlainTextBox, type PlainTextBoxHandle } from "../../components/plain-text-box.tsx";
import { Decision, PromptState, ToolKind, type ApprovalFile, type ApprovalHeader, type ApprovalItem, type ApprovalSecret, type ApprovalWrite } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../../components/screen-icons.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { formatBytes } from "../../messaging/media/media-format.ts";
import { ServicesContext } from "../../messaging/data/services.tsx";
import type { MachinesCopy } from "../copy-vi.ts";
import { MachineIcon, type MachineIconName } from "../machine-icons.tsx";
import { errorText } from "../use-machines.ts";
import { useMachinesCopy } from "../use-machines-copy.ts";

export function toolIcon(kind: ToolKind): MachineIconName {
	switch (kind) {
		case ToolKind.SHELL:
			return "terminal";
		case ToolKind.EDIT:
			return "pencil";
		case ToolKind.READ:
		case ToolKind.SEARCH:
			return "list";
		case ToolKind.WEB:
			return "globe";
		case ToolKind.MCP:
			return "plug";
		case ToolKind.SUBAGENT:
			return "cpu";
		default:
			return "chevron-right";
	}
}

function askTitle(t: MachinesCopy, approval: ApprovalItem): string {
	switch (approval.kind) {
		case ToolKind.SHELL:
			return t.approval.shell;
		case ToolKind.EDIT:
			return t.approval.edit;
		case ToolKind.READ:
		case ToolKind.SEARCH:
			return t.approval.read;
		case ToolKind.WEB:
			return t.approval.web;
		default:
			return t.approval.other(approval.name);
	}
}

/** The arguments the AI called the tool with (the card's JSON input); empty when unreadable. */
function inputArgs(input: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(input);
		return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** An id argument as text ("" when absent). */
function idArg(value: unknown): string {
	return typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value)) ? String(value) : "";
}

/** The chat a chat write goes to: `write.chat_id`, or for tools the machine does not describe, the call's own argument. */
export function writeChatId(write: ApprovalWrite, input: string): number {
	if (write.chatId !== 0n) return Number(write.chatId);
	const args = inputArgs(input);
	const id = idArg(write.tool === "chat_forward_messages" ? args.to_chat_id : args.chat_id);
	return id === "" ? 0 : Number(id);
}

/**
 * The card's words for a tool that acts as the user: `summary` in place of the machine's (null: keep the
 * machine's), `reason` always. `knownTitle`: the chat's name as this device shows it ("" when unknown);
 * `input`: the call's JSON arguments, for the tools the machine does not describe.
 */
export function writeWords(t: MachinesCopy, write: ApprovalWrite, knownTitle: string, input = ""): { summary: string | null; reason: string } {
	const w = t.approval.write;
	const more = write.textLength > [...write.text].length ? w.more(write.textLength) : "";
	const text = write.text === "" ? "" : `${write.text}${more}`;
	const title = knownTitle !== "" ? knownTitle : write.chatTitle;
	const args = inputArgs(input);
	// A chat this device knows by name, else the machine's name for it, else its id.
	const to = (): string => {
		if (title !== "") return w.to(title, write.chatMembers);
		const id = writeChatId(write, input);
		return w.toChat(id === 0 ? "?" : String(id));
	};
	switch (write.tool) {
		case "chat_send_message":
			return { summary: title !== "" ? w.send(title, write.chatMembers, text) : w.sendChat(String(write.chatId), text), reason: w.reason };
		case "chat_send_file": {
			// A machine that lists no files (older tunelo) keeps its own line.
			const count = Array.isArray(write.files) ? write.files.length : 0;
			return { summary: count > 0 ? w.sendFiles(count, to(), text) : null, reason: w.reason };
		}
		case "chat_send_media": {
			const media = Array.isArray(args.media_ids) ? args.media_ids.length : 0;
			return { summary: media > 0 ? w.sendMedia(media, to()) : w.sendMediaAny(to()), reason: w.reason };
		}
		case "chat_forward_messages":
			return { summary: w.forward(to()), reason: w.reason };
		case "chat_start_private_chat":
			return { summary: w.startPrivate(idArg(args.user_id) || "?"), reason: w.reason };
		case "localman_send_request":
			return { summary: `${write.method} ${write.url}`, reason: w.reason };
		case "localman_create_collection_node": {
			// A machine before these fields names no collection: its own line stays.
			const collection = lmCollection(write);
			const title = typeof write.title === "string" ? write.title : "";
			return { summary: collection === "" || title === "" ? null : w.lmSave(title, collection, write.method, write.url), reason: w.reason };
		}
		case "kb_save_note": {
			// A machine before these fields sends no title: its own line stays.
			const note = kbNote(t, write);
			return { summary: note === null ? null : w.kbSave(note.title, note.space, note.isPrivate), reason: w.reason };
		}
		default:
			return { summary: null, reason: w.reason };
	}
}

/** A note kb_save_note saves, as the card shows it; null from a machine that does not describe it. */
export function kbNote(t: MachinesCopy, write: ApprovalWrite): { title: string; space: string; isPrivate: boolean; excerpt: string } | null {
	const title = typeof write.title === "string" ? write.title : "";
	if (write.tool !== "kb_save_note" || title === "") return null;
	const w = t.approval.write;
	const space = typeof write.space === "string" && write.space !== "" ? write.space : w.kbOwnSpace;
	const more = write.textLength > [...write.text].length ? w.more(write.textLength) : "";
	return { title, space, isPrivate: write.visibility === "private", excerpt: write.text === "" ? "" : `${write.text}${more}` };
}

/** The collection a saved request goes to: its name, else its id; "" from a machine that does not say. */
function lmCollection(write: ApprovalWrite): string {
	const name = typeof write.collectionName === "string" ? write.collectionName : "";
	const id = typeof write.collectionId === "string" ? write.collectionId : "";
	return name !== "" ? name : id;
}

/** A header as the card lists it: a credential's value never shows. */
export function headerLine(header: Pick<ApprovalHeader, "name" | "value" | "masked">): string {
	return `${header.name}: ${header.masked ? "••••" : header.value}`;
}

/** A Localman request the card sends or saves: where it runs, the collection, the headers and the start of its body. */
function LocalmanDetails({ t, write }: { t: MachinesCopy; write: ApprovalWrite }) {
	const w = t.approval.write;
	// Items built by hand (tests, older journals) may lack the lists.
	const headers: readonly ApprovalHeader[] = Array.isArray(write.headers) ? write.headers : [];
	const save = write.tool === "localman_create_collection_node";
	const collection = save ? lmCollection(write) : "";
	const body = write.tool === "localman_send_request" && write.text !== "" ? `${write.text}${write.textLength > [...write.text].length ? w.more(write.textLength) : ""}` : "";
	const local = write.tool === "localman_send_request" && write.reachesLocal === true;
	if (!local && headers.length === 0 && body === "" && collection === "") return null;
	return (
		<div className="mx-lm-write">
			{local && <span className="mx-tag warn mx-lm-local">{w.lmLocal}</span>}
			<dl className="mx-kb-note">
				{collection !== "" && (
					<div>
						<dt>{w.lmCollection}</dt>
						<dd>{collection}</dd>
					</div>
				)}
				{save && typeof write.title === "string" && write.title !== "" && (
					<div>
						<dt>{w.lmName}</dt>
						<dd>{write.title}</dd>
					</div>
				)}
				{headers.length > 0 && (
					<div>
						<dt>{w.lmHeaders}</dt>
						<dd>
							<ul className="mx-lm-write-headers">
								{headers.map((h, i) => (
									<li key={`${i}:${h.name}`} className="mono">
										{headerLine(h)}
									</li>
								))}
							</ul>
						</dd>
					</div>
				)}
				{body !== "" && (
					<div>
						<dt>{w.lmBody}</dt>
						<dd className="mx-pre">{body}</dd>
					</div>
				)}
			</dl>
		</div>
	);
}

/** The note a kb_save_note card saves: title, Space, who reads it and the start of its text. */
function KbNoteDetails({ t, write }: { t: MachinesCopy; write: ApprovalWrite }) {
	const note = kbNote(t, write);
	if (note === null) return null;
	const w = t.approval.write;
	return (
		<dl className="mx-kb-note">
			<div>
				<dt>{w.kbTitle}</dt>
				<dd>{note.title}</dd>
			</div>
			<div>
				<dt>{w.kbSpace}</dt>
				<dd>{note.space}</dd>
			</div>
			{note.isPrivate && (
				<div>
					<dt>{w.kbVisibility}</dt>
					<dd>{w.kbPrivate}</dd>
				</div>
			)}
			{note.excerpt !== "" && (
				<div>
					<dt>{w.kbExcerpt}</dt>
					<dd className="mx-pre">{note.excerpt}</dd>
				</div>
			)}
		</dl>
	);
}

/** The machine's English reason a file will not be sent, in the user's language (an unknown one as it came). */
export function fileProblem(t: MachinesCopy, problem: string): string {
	return t.approval.write.problems[problem] ?? problem;
}

/** A photo's preview as a page address while the row shows (freed after); null for no preview. */
function usePreviewUrl(file: ApprovalFile): string | null {
	const { preview, mime } = file;
	const [url, setUrl] = useState<string | null>(null);
	useEffect(() => {
		if (preview.length === 0 || typeof URL.createObjectURL !== "function") return;
		const made = URL.createObjectURL(new Blob([new Uint8Array(preview)], { type: mime }));
		// The address is an external resource made for this row: set once made, freed when the row goes.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		setUrl(made);
		return () => {
			URL.revokeObjectURL(made);
			setUrl(null);
		};
	}, [preview, mime]);
	return url;
}

function FileRow({ file, t }: { file: ApprovalFile; t: MachinesCopy }) {
	const { locale } = useI18n();
	const url = usePreviewUrl(file);
	const problem = file.problem === "" ? "" : fileProblem(t, file.problem);
	return (
		<li className={problem === "" ? "mx-send-file" : "mx-send-file bad"}>
			{url !== null ? <img src={url} alt={file.name} /> : <Icon name="file" />}
			<span className="nm" title={file.name}>
				{file.name}
			</span>
			{problem === "" ? (
				<span className="muted">{formatBytes(Number(file.size), locale)}</span>
			) : (
				<span className="mx-send-problem" role="alert">
					{t.approval.write.cannotSend}: {problem}
				</span>
			)}
		</li>
	);
}

/** The machine's files a chat_send_file card sends, one row each. */
function SendFiles({ files, t }: { files: readonly ApprovalFile[]; t: MachinesCopy }) {
	if (files.length === 0) return null;
	return (
		<ul className="mx-send-files" aria-label={t.approval.write.files}>
			{files.map((file, i) => (
				<FileRow key={`${i}:${file.name}`} file={file} t={t} />
			))}
		</ul>
	);
}

/** The name of chat `chatId` as the chat list shows it (a group's title, the other person's name); "" when this device does not know it. */
function useKnownChatTitle(chatId: number): string {
	// The AI Agent screens live inside the Chat app's services; a card drawn alone (tests) knows no chat.
	const services = useContext(ServicesContext);
	const store = services?.store ?? null;
	const subscribe = useCallback((listener: () => void) => (store === null || chatId === 0 ? () => undefined : store.subscribe(`dialog:${chatId}`, listener)), [store, chatId]);
	return useSyncExternalStore(subscribe, () => {
		const view = store === null || chatId === 0 ? undefined : store.dialog(chatId);
		if (view === undefined || view.chat === null) return "";
		return view.chat.type === "private" ? (view.peer?.name ?? "") : view.chat.title;
	});
}

/** The summary and reason the card shows: the machine's, or for a tool acting as the user, worded here. */
function useApprovalWords(t: MachinesCopy, approval: ApprovalItem): { summary: string; reason: string } {
	// Items built by hand (tests, older journals) may lack the field.
	const write: ApprovalWrite | undefined = approval.write;
	const input = typeof approval.input === "string" ? approval.input : "";
	const known = useKnownChatTitle(write === undefined || !write.tool.startsWith("chat_") ? 0 : writeChatId(write, input));
	if (write === undefined) return { summary: approval.summary, reason: approval.reason };
	const words = writeWords(t, write, known, input);
	return { summary: words.summary ?? approval.summary, reason: words.reason };
}

/** What became of an answered (or expired, cancelled) prompt. */
export function approvalOutcome(t: MachinesCopy, approval: ApprovalItem): string {
	switch (approval.state) {
		case PromptState.ANSWERED:
			if (approval.decision === Decision.DENY) return approval.denyMessage === "" ? t.approval.denied : `${t.approval.denied}: “${approval.denyMessage}”`;
			return approval.decision === Decision.ALLOW_SESSION ? t.approval.allowedSession : t.approval.allowed;
		case PromptState.EXPIRED:
			return t.approval.expired;
		default:
			return t.approval.cancelled;
	}
}

/** `$TUNELO_SECRET_X` / `${TUNELO_SECRET_X}` in a command: tunelo hands it a sign-in secret. */
const SECRET_REFERENCE = /\$\{?TUNELO_SECRET_([A-Z][A-Z0-9_]{0,47})\b/g;

/**
 * The sign-in secrets a shell command reads, from its input as the card
 * shows it. The machine asks about such a command every time and never
 * allows it for the session.
 */
export function secretsInCommand(approval: Pick<ApprovalItem, "kind" | "input">): string[] {
	if (approval.kind !== ToolKind.SHELL) return [];
	// Items built by hand (tests, older journals) may lack the input.
	const input: string = typeof approval.input === "string" ? approval.input : "";
	return [...new Set([...input.matchAll(SECRET_REFERENCE)].map((m) => m[1] ?? "").filter(Boolean))];
}

/**
 * The site of a secret as the card shows it: the host for https (the part a
 * user checks), the whole origin otherwise (http on loopback).
 */
export function siteLabel(origin: string): string {
	return origin.startsWith("https://") ? origin.slice("https://".length) : origin;
}

/**
 * The secrets a command reads with their sites, from the machine (tunelo
 * 2.0.11+); older machines send none and the card names them from the input.
 * Items built by hand (tests, older journals) may lack the list.
 */
export function secretSites(approval: Pick<ApprovalItem, "secrets">): readonly ApprovalSecret[] {
	return Array.isArray(approval.secrets) ? approval.secrets : [];
}

/** At most this long, as the machine accepts it. */
export const DENY_MESSAGE_MAX = 4000;

interface ApprovalCardProps {
	approval: ApprovalItem;
	ai: string;
	/** The AI can remember "allow for the session" (capabilities.session_allow). */
	sessionAllow: boolean;
	/** `message`: with a denial, what the AI should do instead. */
	onDecide: (decision: Decision, message?: string) => Promise<void>;
	/** Shorter form for the board's tiles: Allow and Deny only. */
	compact?: boolean;
	/** Answer keys 1, 2, 3 and Esc (the card above a session's composer). */
	hotkeys?: boolean;
}

/** A key press belongs to the page, not to text being typed (an empty composer counts as not typing). */
export function freeForHotkey(event: KeyboardEvent): boolean {
	if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return false;
	if (document.querySelector("dialog[open]") !== null) return false;
	const target = event.target;
	if (!(target instanceof HTMLElement)) return true;
	// A part of the screen with keys of its own (the workspace panel's tree and buttons) keeps them.
	if (target.closest("[data-own-keys]") !== null) return false;
	if (target.dataset.composer !== undefined) return (target.textContent ?? "") === "";
	return !(target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement);
}

export function ApprovalCard({ approval, ai, sessionAllow, onDecide, compact = false, hotkeys = false }: ApprovalCardProps) {
	const t = useMachinesCopy();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [telling, setTelling] = useState(false);
	const [message, setMessage] = useState("");
	const field = useRef<PlainTextBoxHandle>(null);
	const pending = approval.state === PromptState.PENDING;
	const words = useApprovalWords(t, approval);
	const sites = secretSites(approval);
	const secrets = sites.length > 0 ? sites.map((s) => s.name) : secretsInCommand(approval);
	// Asking macOS for a protected folder is never allowed for the session.
	const canSession = !approval.sensitive && sessionAllow && !compact && secrets.length === 0 && !approval.macFolder;
	const decide = (decision: Decision, note?: string) => {
		if (busy) return;
		setBusy(true);
		setError("");
		onDecide(decision, note).then(
			() => setBusy(false),
			(err: unknown) => {
				setBusy(false);
				setError(errorText(t, err, ai));
			},
		);
	};
	const tell = () => {
		setTelling(true);
		queueMicrotask(() => field.current?.focus());
	};
	const sendTell = () => {
		const note = message.trim();
		if (note === "") return;
		decide(Decision.DENY, note.slice(0, DENY_MESSAGE_MAX));
	};
	const onKey = useEffectEvent((event: KeyboardEvent) => {
		if (!pending || busy || telling || !freeForHotkey(event)) return;
		const key = event.key;
		if (key === "1") decide(Decision.ALLOW);
		else if (key === "2" && canSession) decide(Decision.ALLOW_SESSION);
		else if (key === "3") tell();
		else if (key === "Escape") decide(Decision.DENY);
		else return;
		event.preventDefault();
	});
	useEffect(() => {
		if (!hotkeys) return;
		const listener = (event: KeyboardEvent) => onKey(event);
		document.addEventListener("keydown", listener);
		return () => document.removeEventListener("keydown", listener);
	}, [hotkeys]);
	if (!pending) {
		return (
			<div className="mx-done-line">
				<MachineIcon name={toolIcon(approval.kind)} small />
				<span className="mono">{words.summary || approval.name}</span>
				<span className="muted">· {approvalOutcome(t, approval)}</span>
			</div>
		);
	}
	const key = (k: string) =>
		hotkeys ? (
			<kbd className="mx-kbd" aria-hidden="true">
				{k}
			</kbd>
		) : null;
	return (
		<div className={approval.sensitive ? "mx-action sensitive" : "mx-action"} role="group" aria-label={t.approval.label(ai)}>
			<h4>
				<MachineIcon name={toolIcon(approval.kind)} />
				<span>{askTitle(t, approval)}</span>
				{approval.sensitive && <span className="mx-tag danger">{t.approval.sensitive}</span>}
			</h4>
			{words.summary !== "" && <pre className="mx-pre">{words.summary}</pre>}
			{approval.write?.tool === "chat_send_file" && Array.isArray(approval.write.files) && <SendFiles files={approval.write.files} t={t} />}
			{approval.write?.tool === "kb_save_note" && <KbNoteDetails t={t} write={approval.write} />}
			{(approval.write?.tool === "localman_send_request" || approval.write?.tool === "localman_create_collection_node") && <LocalmanDetails t={t} write={approval.write} />}
			{sites.length > 0 && (
				<ul className="mx-secret-sites" aria-label={t.approval.secretSites}>
					{sites.map((s) => (
						<li key={s.name}>
							{s.origin === "" ? <span className="muted">{t.approval.secretNoSite}</span> : <strong title={s.origin}>{siteLabel(s.origin)}</strong>}
							<code>{s.name}</code>
						</li>
					))}
				</ul>
			)}
			{approval.macFolder ? (
				// Worded here: the machine's English reason says the same.
				<p className="mx-warn mx-reason" data-id="approval-mac-folder">
					{t.approval.macFolder(approval.macFolder)}
				</p>
			) : secrets.length > 0 ? (
				// Worded here: tunelo 2.0.8 sent its own English reason for these, which is left out.
				<p className="muted mx-reason">{t.approval.secretCommand(secrets.join(", "))}</p>
			) : (
				!compact && words.reason !== "" && <p className="muted mx-reason">{words.reason}</p>
			)}
			{telling ? (
				<div className="mx-tell">
					<PlainTextBox
						id={`tell-${approval.toolId}`}
						ref={field}
						className="mx-field"
						ariaLabel={t.agent.dock.tellLabel(ai)}
						maxLength={DENY_MESSAGE_MAX}
						placeholder={t.agent.dock.tellPlaceholder(ai)}
						value={message}
						disabled={busy}
						onValueChange={setMessage}
						onKeyDown={(event) => {
							// The box never hands over keys an IME is composing with.
							if (event.key === "Escape") {
								event.preventDefault();
								event.stopPropagation();
								setTelling(false);
							} else if (event.key === "Enter" && !event.shiftKey) {
								event.preventDefault();
								sendTell();
							}
						}}
					/>
					<div className="acts">
						<button type="button" className="btn btn-primary btn-sm" disabled={busy || message.trim() === ""} onClick={sendTell}>
							{t.agent.dock.tellSend}
						</button>
						<button type="button" className="btn btn-sm" disabled={busy} onClick={() => setTelling(false)}>
							{t.agent.dock.cancel}
						</button>
					</div>
				</div>
			) : (
				<div className="acts">
					<button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => decide(Decision.ALLOW)}>
						{key("1")}
						{t.approval.allow}
					</button>
					{canSession && (
						<button type="button" className="btn btn-sm" disabled={busy} onClick={() => decide(Decision.ALLOW_SESSION)}>
							{key("2")}
							{t.approval.allowSession}
						</button>
					)}
					{!compact && (
						<button type="button" className="btn btn-sm" disabled={busy} onClick={tell}>
							{key("3")}
							{t.agent.dock.denyTell(ai)}
						</button>
					)}
					<button type="button" className="btn btn-sm danger-outline" disabled={busy} onClick={() => decide(Decision.DENY)}>
						{key("Esc")}
						{t.approval.deny}
					</button>
				</div>
			)}
			{error !== "" && (
				<p className="mx-error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}
