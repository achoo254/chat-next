// Source Control against the machine: git's status (read on open, after a
// change the machine reports, and from the answer of every write), and the
// writes: stage, unstage, discard, commit, checkout, new branch, fetch, pull
// and push, one at a time. A write that needs the user's consent stops at a
// confirmation first: discarding (always), taking in a secret file (named),
// committing on a detached HEAD. The machine refuses without that consent,
// and such a refusal opens the same confirmation. A confirmation holds what
// to do once accepted, as data.
import { useCallback, useEffect, useRef, useState } from "react";
import type { WsChanged, WsGitStatusResult } from "@achoo254/chat-proto/remote/remote";
import { ask, type WsLink } from "../ws-client.ts";
import { isDetachedRefusal, unconfirmedSensitive } from "../ws-errors.ts";
import { discardKinds, sensitivePaths, stagedEntries, unstagedEntries } from "./status-model.ts";

export type ScmOp = "status" | "stage" | "unstage" | "discard" | "commit" | "checkout" | "branch" | "fetch" | "pull" | "push";

type Targets = readonly string[] | "all";

/** A commit waiting for consent: its message, what was agreed so far, and what to run after it. */
interface PendingCommit {
	readonly message: string;
	readonly allowDetached: boolean;
	readonly consented: readonly string[];
	readonly onDone: () => void;
}

export type Confirm =
	| { readonly kind: "discard"; readonly paths: readonly string[]; readonly count: number; readonly untracked: number; readonly tracked: number }
	| { readonly kind: "sensitive"; readonly op: "stage"; readonly paths: readonly string[]; readonly targets: Targets; readonly consented: readonly string[] }
	| { readonly kind: "sensitive"; readonly op: "commit"; readonly paths: readonly string[]; readonly commit: PendingCommit }
	| { readonly kind: "detached"; readonly commit: PendingCommit };

export interface Scm {
	readonly status: WsGitStatusResult | null;
	readonly statusError: unknown;
	readonly busy: ScmOp | null;
	/** The last write that failed, and why; null when none (or dismissed). */
	readonly failure: { readonly op: ScmOp; readonly error: unknown } | null;
	readonly confirm: Confirm | null;
	/** Bumps after each write that may move HEAD or the branch (commits and compare read again). */
	readonly history: number;
	readonly refresh: () => void;
	readonly stage: (paths: Targets) => void;
	readonly unstage: (paths: Targets) => void;
	readonly discard: (paths: readonly string[]) => void;
	readonly commit: (message: string, onDone: () => void) => void;
	readonly checkout: (branch: string) => void;
	readonly createBranch: (name: string) => Promise<boolean>;
	readonly remote: (op: "fetch" | "pull" | "push") => void;
	/** The user agreed to the confirmation shown. */
	readonly accept: () => void;
	readonly cancelConfirm: () => void;
	readonly dismissFailure: () => void;
	readonly onChange: (change: WsChanged) => void;
}

export function useScm(link: WsLink, workspaceId: string, online: boolean): Scm {
	const [status, setStatus] = useState<WsGitStatusResult | null>(null);
	const [statusError, setStatusError] = useState<unknown>(null);
	const [busy, setBusy] = useState<ScmOp | null>(null);
	const [failure, setFailure] = useState<Scm["failure"]>(null);
	const [confirm, setConfirm] = useState<Confirm | null>(null);
	const [history, setHistory] = useState(0);
	const statusRef = useRef(status);
	const busyRef = useRef(busy);
	const ws = workspaceId;

	const take = useCallback((next: WsGitStatusResult) => {
		const before = statusRef.current;
		statusRef.current = next;
		setStatus(next);
		setStatusError(null);
		if (before !== null && (before.head !== next.head || before.branch !== next.branch)) setHistory((h) => h + 1);
	}, []);

	const refresh = useCallback(() => {
		ask(link, { case: "wsGitStatus", value: { workspaceId: ws } }, "wsGitStatusResult").then(take, (err: unknown) => setStatusError(err));
	}, [link, ws, take]);

	useEffect(() => {
		if (online) refresh();
	}, [online, refresh]);

	/** Runs one write that answers with the status; false when it failed (the failure shows, or its confirmation). */
	const write = useCallback(
		async (op: ScmOp, run: () => Promise<WsGitStatusResult>, moves = false): Promise<boolean> => {
			if (busyRef.current !== null) return false;
			busyRef.current = op;
			setBusy(op);
			setFailure(null);
			try {
				take(await run());
				if (moves) setHistory((h) => h + 1);
				return true;
			} catch (error) {
				if (unconfirmedSensitive(error) === null && !isDetachedRefusal(error)) setFailure({ op, error });
				return false;
			} finally {
				busyRef.current = null;
				setBusy(null);
			}
		},
		[take],
	);

	/** Stages with consent for `consented`; a refusal naming more secret files asks about those. */
	const stageWith = useCallback(
		(targets: Targets, consented: readonly string[]) => {
			const all = targets === "all";
			void write("stage", () =>
				ask(link, { case: "wsGitStage", value: { workspaceId: ws, paths: all ? [] : [...targets], all, confirmSensitive: [...consented] } }, "wsGitStatusResult").catch((err: unknown) => {
					const named = unconfirmedSensitive(err);
					if (named !== null) setConfirm({ kind: "sensitive", op: "stage", paths: named, targets, consented: [...consented, ...named] });
					throw err;
				}),
			);
		},
		[link, ws, write],
	);

	const stage = useCallback(
		(targets: Targets) => {
			const entries = unstagedEntries(statusRef.current?.entries ?? []);
			const taken = targets === "all" ? entries : entries.filter((e) => targets.includes(e.path));
			const secret = sensitivePaths(taken);
			if (secret.length > 0) setConfirm({ kind: "sensitive", op: "stage", paths: secret, targets, consented: secret });
			else stageWith(targets, []);
		},
		[stageWith],
	);

	const unstage = useCallback(
		(targets: Targets) => {
			const all = targets === "all";
			void write("unstage", () => ask(link, { case: "wsGitUnstage", value: { workspaceId: ws, paths: all ? [] : [...targets], all } }, "wsGitStatusResult"));
		},
		[link, ws, write],
	);

	const discard = useCallback((paths: readonly string[]) => {
		if (paths.length === 0) return;
		setConfirm({ kind: "discard", paths, count: paths.length, ...discardKinds(statusRef.current?.entries ?? [], paths) });
	}, []);

	/** Commits once every consent it needs is given; else shows the next confirmation. */
	const commitWith = useCallback(
		(pending: PendingCommit) => {
			const current = statusRef.current;
			if (!pending.allowDetached && current !== null && current.branch === "" && current.head !== "") {
				setConfirm({ kind: "detached", commit: pending });
				return;
			}
			const secret = sensitivePaths(stagedEntries(current?.entries ?? [])).filter((path) => !pending.consented.includes(path));
			if (secret.length > 0) {
				setConfirm({ kind: "sensitive", op: "commit", paths: secret, commit: { ...pending, consented: [...pending.consented, ...secret] } });
				return;
			}
			const value = { workspaceId: ws, message: pending.message, allowDetached: pending.allowDetached, confirmSensitive: [...pending.consented] };
			void write(
				"commit",
				async () => {
					try {
						await ask(link, { case: "wsGitCommit", value }, "wsGitCommitResult");
					} catch (err) {
						const named = unconfirmedSensitive(err);
						if (named !== null) setConfirm({ kind: "sensitive", op: "commit", paths: named, commit: { ...pending, consented: [...pending.consented, ...named] } });
						else if (isDetachedRefusal(err)) setConfirm({ kind: "detached", commit: pending });
						throw err;
					}
					pending.onDone();
					return ask(link, { case: "wsGitStatus", value: { workspaceId: ws } }, "wsGitStatusResult");
				},
				true,
			);
		},
		[link, ws, write],
	);

	const commit = useCallback((message: string, onDone: () => void) => commitWith({ message, allowDetached: false, consented: [], onDone }), [commitWith]);

	const accept = useCallback(() => {
		const c = confirm;
		setConfirm(null);
		if (c === null) return;
		if (c.kind === "discard") {
			void write("discard", () => ask(link, { case: "wsGitDiscard", value: { workspaceId: ws, paths: [...c.paths], confirm: true } }, "wsGitStatusResult"));
		} else if (c.kind === "detached") commitWith({ ...c.commit, allowDetached: true });
		else if (c.op === "stage") stageWith(c.targets, c.consented);
		else commitWith(c.commit);
	}, [confirm, link, ws, write, stageWith, commitWith]);

	const checkout = useCallback(
		(branch: string) => void write("checkout", () => ask(link, { case: "wsGitCheckout", value: { workspaceId: ws, branch } }, "wsGitStatusResult"), true),
		[link, ws, write],
	);

	const createBranch = useCallback(
		(name: string) => write("branch", () => ask(link, { case: "wsGitBranchCreate", value: { workspaceId: ws, name, startPoint: "", checkout: true } }, "wsGitStatusResult"), true),
		[link, ws, write],
	);

	const remote = useCallback(
		(op: "fetch" | "pull" | "push") => {
			const value = { workspaceId: ws };
			const body = op === "fetch" ? ({ case: "wsGitFetch", value } as const) : op === "pull" ? ({ case: "wsGitPull", value } as const) : ({ case: "wsGitPush", value } as const);
			void write(op, () => ask(link, body, "wsGitStatusResult"), true);
		},
		[link, ws, write],
	);

	const onChange = useCallback(
		(change: WsChanged) => {
			if (change.git || change.overflow) refresh();
		},
		[refresh],
	);

	const cancelConfirm = useCallback(() => setConfirm(null), []);
	const dismissFailure = useCallback(() => setFailure(null), []);
	return { status, statusError, busy, failure, confirm, history, refresh, stage, unstage, discard, commit, checkout, createBranch, remote, accept, cancelConfirm, dismissFailure, onChange };
}
