// A tool waiting for the user's permission: Allow, Allow for the session (not
// for a sensitive path, nor when the AI cannot remember it), Deny and tell
// the AI what to do instead, Deny. In a session the card sits above the
// composer and answers keys 1, 2, 3 and Esc. The answer names the revision
// the user saw, so a prompt that changed meanwhile is refused instead of
// answered blindly. An answered prompt shows in its tool's row
// (tool-run.tsx); one without a shown tool stays as a short line.
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Decision, PromptState, ToolKind, type ApprovalItem } from "@achoo254/chat-proto/remote/remote";
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
	if (target instanceof HTMLTextAreaElement && target.dataset.composer !== undefined) return target.value === "";
	return !(target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement);
}

export function ApprovalCard({ approval, ai, sessionAllow, onDecide, compact = false, hotkeys = false }: ApprovalCardProps) {
	const t = useMachinesCopy();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [telling, setTelling] = useState(false);
	const [message, setMessage] = useState("");
	const field = useRef<HTMLTextAreaElement>(null);
	const pending = approval.state === PromptState.PENDING;
	const secrets = secretsInCommand(approval);
	const canSession = !approval.sensitive && sessionAllow && !compact && secrets.length === 0;
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
				<span className="mono">{approval.summary || approval.name}</span>
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
			{approval.summary !== "" && <pre className="mx-pre">{approval.summary}</pre>}
			{secrets.length > 0 ? (
				// Worded here: tunelo 2.0.8 sent its own English reason for these, which is left out.
				<p className="muted mx-reason">{t.approval.secretCommand(secrets.join(", "))}</p>
			) : (
				!compact && approval.reason !== "" && <p className="muted mx-reason">{approval.reason}</p>
			)}
			{telling ? (
				<div className="mx-tell">
					<label className="sr-only" htmlFor={`tell-${approval.toolId}`}>
						{t.agent.dock.tellLabel}
					</label>
					<textarea
						id={`tell-${approval.toolId}`}
						ref={field}
						rows={2}
						className="mx-field"
						maxLength={DENY_MESSAGE_MAX}
						placeholder={t.agent.dock.tellPlaceholder}
						value={message}
						disabled={busy}
						onChange={(event) => setMessage(event.target.value)}
						onKeyDown={(event) => {
							if (event.nativeEvent.isComposing) return;
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
							{t.agent.dock.denyTell}
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
