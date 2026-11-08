// A tool waiting for the user's permission: Allow, Allow for the session (not
// for a sensitive path, nor when the AI cannot remember it), Deny. The answer
// names the revision the user saw, so a prompt that changed meanwhile is
// refused instead of answered blindly. Answered prompts stay as a short line.
import { useState } from "react";
import { Decision, PromptState, ToolKind, type ApprovalItem } from "@achoo254/chat-proto/remote/remote";
import type { MachinesCopy } from "../copy-vi.ts";
import { MachineIcon, type MachineIconName } from "../machine-icons.tsx";
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

function outcome(t: MachinesCopy, approval: ApprovalItem): string {
	switch (approval.state) {
		case PromptState.ANSWERED:
			return approval.decision === Decision.DENY ? t.approval.denied : approval.decision === Decision.ALLOW_SESSION ? t.approval.allowedSession : t.approval.allowed;
		case PromptState.EXPIRED:
			return t.approval.expired;
		default:
			return t.approval.cancelled;
	}
}

interface ApprovalCardProps {
	approval: ApprovalItem;
	ai: string;
	/** The AI can remember "allow for the session" (capabilities.session_allow). */
	sessionAllow: boolean;
	onDecide: (decision: Decision) => Promise<void>;
	/** Shorter form for the session board's tiles. */
	compact?: boolean;
}

export function ApprovalCard({ approval, ai, sessionAllow, onDecide, compact = false }: ApprovalCardProps) {
	const t = useMachinesCopy();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const pending = approval.state === PromptState.PENDING;
	if (!pending) {
		return (
			<div className="mx-done-line">
				<MachineIcon name={toolIcon(approval.kind)} small />
				<span className="mono">{approval.summary || approval.name}</span>
				<span className="muted">· {outcome(t, approval)}</span>
			</div>
		);
	}
	const decide = (decision: Decision) => {
		setBusy(true);
		setError("");
		onDecide(decision).then(
			() => setBusy(false),
			(err: unknown) => {
				setBusy(false);
				setError(err instanceof Error ? err.message : String(err));
			},
		);
	};
	return (
		<div className={approval.sensitive ? "mx-action sensitive" : "mx-action"} role="group" aria-label={t.approval.label(ai)}>
			<h4>
				<MachineIcon name={toolIcon(approval.kind)} />
				<span>{askTitle(t, approval)}</span>
				{approval.sensitive && <span className="mx-tag danger">{t.approval.sensitive}</span>}
			</h4>
			{approval.summary !== "" && <pre className="mx-pre">{approval.summary}</pre>}
			{!compact && approval.reason !== "" && <p className="muted mx-reason">{approval.reason}</p>}
			<div className="acts">
				<button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => decide(Decision.ALLOW)}>
					{t.approval.allow}
				</button>
				{!approval.sensitive && sessionAllow && !compact && (
					<button type="button" className="btn btn-sm" disabled={busy} onClick={() => decide(Decision.ALLOW_SESSION)}>
						{t.approval.allowSession}
					</button>
				)}
				<button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => decide(Decision.DENY)}>
					{t.approval.deny}
				</button>
			</div>
			{error !== "" && (
				<p className="mx-error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}
