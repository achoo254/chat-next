// Source Control's top rows: "Create PR" (the GitHub or GitLab page that
// opens a pull request for the branch, in a new tab without an opener), the
// branch selector with its upstream and ahead/behind (switch, or a new
// branch), and fetch, pull and push with their busy state.
import { useState } from "react";
import type { WsGitBranchesResult, WsGitStatusResult } from "@achoo254/chat-proto/remote/remote";
import { MachineIcon } from "../../machine-icons.tsx";
import { usePopover } from "../../use-popover.ts";
import { PanelIcon, type PanelIconName } from "../panel-icons.tsx";
import { usePanelCopy } from "../use-panel-copy.ts";
import type { Loadable } from "./use-history.ts";
import type { ScmOp } from "./use-scm.ts";

interface BranchBarProps {
	status: WsGitStatusResult;
	pr: Loadable<string>;
	branches: Loadable<WsGitBranchesResult>;
	busy: ScmOp | null;
	online: boolean;
	onLoadBranches: () => void;
	onCheckout: (branch: string) => void;
	onNewBranch: () => void;
	onRemote: (op: "fetch" | "pull" | "push") => void;
	errorText: (err: unknown) => string;
}

/** Remote branches to offer by their short name ("feature" for "origin/feature"), leaving out those a local branch has. */
export function remoteChoices(result: WsGitBranchesResult): string[] {
	const local = new Set(result.local.map((b) => b.name));
	const short = result.remote.map((name) => name.slice(name.indexOf("/") + 1)).filter((name) => name !== "" && !local.has(name));
	return [...new Set(short)];
}

export function BranchBar({ status, pr, branches, busy, online, onLoadBranches, onCheckout, onNewBranch, onRemote, errorText }: BranchBarProps) {
	const p = usePanelCopy();
	const s = p.scm;
	const { open: menuOpen, setOpen: setMenuOpen, ref: menuRef } = usePopover();
	const [filter, setFilter] = useState("");
	const detached = status.branch === "";
	const up = status.upstream;
	const label = detached ? s.detached(status.head.slice(0, 7)) : status.branch;
	const remoteButton = (op: "fetch" | "pull" | "push", icon: PanelIconName, text: string, hint: string) => (
		<button
			type="button"
			className="btn btn-sm ws-remote"
			aria-label={text}
			title={`${text}: ${hint}`}
			disabled={!online || busy !== null}
			aria-busy={busy === op}
			onClick={() => onRemote(op)}
			data-id={`workspace-git-${op}`}
		>
			{busy === op ? <MachineIcon name="spinner" small /> : <PanelIcon name={icon} small />}
		</button>
	);
	const pick = (name: string) => {
		setMenuOpen(false);
		setFilter("");
		onCheckout(name);
	};
	const match = (name: string) => name.toLowerCase().includes(filter.trim().toLowerCase());
	return (
		<div className="ws-branchbar">
			<div className="ws-row-actions">
				{pr.kind === "ready" ? (
					<a className="btn btn-sm btn-primary ws-pr" href={pr.value} target="_blank" rel="noopener noreferrer" title={s.createPrHint} data-id="workspace-create-pr">
						<PanelIcon name="pull-request" small />
						<span>{s.createPr}</span>
					</a>
				) : (
					<button type="button" className="btn btn-sm ws-pr" disabled title={pr.kind === "error" && pr.error !== null ? errorText(pr.error) : s.prUnavailable}>
						<PanelIcon name="pull-request" small />
						<span>{s.createPr}</span>
					</button>
				)}
				<div className="mx-model ws-branch" ref={menuRef}>
					<button
						type="button"
						className="btn btn-sm ws-branch-btn"
						aria-haspopup="menu"
						aria-expanded={menuOpen}
						aria-label={`${s.branch}: ${label}`}
						disabled={!online}
						onClick={() => {
							if (!menuOpen) onLoadBranches();
							setMenuOpen((v) => !v);
						}}
						data-id="workspace-branch"
					>
						<MachineIcon name="branch" small />
						<span className="ws-branch-name">{label}</span>
						<MachineIcon name="chevron-down" small />
					</button>
					{menuOpen && (
						<div className="mx-menu ws-menu ws-branch-menu" role="menu" aria-label={s.branch}>
							<input className="ws-filter" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={s.filterBranches} aria-label={s.filterBranches} autoComplete="off" spellCheck={false} />
							<button type="button" role="menuitem" onClick={() => {
									setMenuOpen(false);
									onNewBranch();
								}} data-id="workspace-new-branch">
								<PanelIcon name="plus" small />
								{s.newBranch}
							</button>
							<hr />
							{branches.kind === "loading" && <p className="mx-menu-note">{p.loading}</p>}
							{branches.kind === "error" && <p className="mx-menu-note mx-error">{errorText(branches.error)}</p>}
							{branches.kind === "ready" && (
								<>
									<h5>{s.localBranches}</h5>
									{branches.value.local.filter((b) => match(b.name)).map((b) => (
										<button key={b.name} type="button" role="menuitemradio" aria-checked={b.name === branches.value.current} onClick={() => pick(b.name)}>
											<span className="ws-check">{b.name === branches.value.current && <PanelIcon name="check" small />}</span>
											<span className="ws-branch-name">{b.name}</span>
											<small>{b.gone ? s.gone : b.upstream}</small>
											{(b.ahead > 0 || b.behind > 0) && <AheadBehind ahead={b.ahead} behind={b.behind} />}
										</button>
									))}
									{remoteChoices(branches.value).filter(match).length > 0 && <h5>{s.remoteBranches}</h5>}
									{remoteChoices(branches.value).filter(match).map((name) => (
										<button key={name} type="button" role="menuitem" onClick={() => pick(name)}>
											<span className="ws-check" />
											<span className="ws-branch-name">{name}</span>
										</button>
									))}
								</>
							)}
						</div>
					)}
				</div>
			</div>
			<div className="ws-row-actions">
				<span className="ws-upstream" title={up === undefined ? s.noUpstream : up.name}>
					{up === undefined ? s.noUpstream : up.name}
					{up !== undefined && <AheadBehind ahead={up.ahead} behind={up.behind} />}
				</span>
				{remoteButton("fetch", "fetch", s.fetch, s.fetchHint)}
				{remoteButton("pull", "arrow-down", s.pull, s.pullHint)}
				{remoteButton("push", "arrow-up", s.push, s.pushHint)}
			</div>
		</div>
	);
}

function AheadBehind({ ahead, behind }: { ahead: number; behind: number }) {
	const p = usePanelCopy();
	return (
		<span className="ws-ab">
			{ahead > 0 && (
				<span title={p.scm.ahead(ahead)} aria-hidden="true">
					↑{ahead}
				</span>
			)}
			{behind > 0 && (
				<span title={p.scm.behind(behind)} aria-hidden="true">
					↓{behind}
				</span>
			)}
			<span className="sr-only">{[ahead > 0 ? p.scm.ahead(ahead) : "", behind > 0 ? p.scm.behind(behind) : ""].filter(Boolean).join(", ")}</span>
		</span>
	);
}
