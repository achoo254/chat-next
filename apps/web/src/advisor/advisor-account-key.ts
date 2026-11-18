// The account's TypeSafe key as this device sees it across the machines it
// links to (MachineInfo.advisor of each): which machines hold it, which need
// it, which hold one removed since (AdvisorProfile.key_removed_at), and the
// three requests that hand it from one machine to another. This device never
// holds the key: it relays the receiver's ticket public key, learned over its
// own end-to-end link to that machine, and the sealed bytes the holder answers.
import { AdvisorKeySource } from "@achoo254/chat-proto/remote/remote";
import type { MachineView } from "../machines/use-machines.ts";

/** One machine's key as its info tells it. */
export interface MachineKeyState {
	/** The link is open and the machine names Advisor. */
	readonly reachable: boolean;
	/** The machine takes the account's key (tunelo 3.22.0+). */
	readonly share: boolean;
	readonly source: "none" | "own" | "account";
	readonly fingerprint: string;
	readonly setAt: number;
	readonly setByDevice: string;
}

export function keyStateOf(view: MachineView): MachineKeyState {
	const advisor = view.state.info?.advisor;
	const reachable = view.state.status.kind === "open" && advisor !== undefined;
	if (advisor === undefined || !advisor.keySet) {
		return { reachable, share: advisor?.keyShare === true, source: "none", fingerprint: "", setAt: 0, setByDevice: "" };
	}
	// A key from a tunelo that names no source is the machine's own.
	const source = advisor.keySource === AdvisorKeySource.ACCOUNT ? "account" : "own";
	return { reachable, share: advisor.keyShare, source, fingerprint: advisor.keyFingerprint, setAt: Number(advisor.setAt), setByDevice: advisor.setByDevice };
}

/** Orders two account keys: the later set time wins, then the fingerprint (every device picks the same one). */
function compareKeys(a: MachineKeyState, b: MachineKeyState): number {
	return a.setAt - b.setAt || (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0);
}

/** A machine as the sync sees it. */
export interface KeyMachine {
	readonly view: MachineView;
	readonly key: MachineKeyState;
}

/** What this device should do about the account's key on the machines it reaches now. */
export interface KeySyncPlan {
	/** The machine whose account key the others take; null without a live one in reach. */
	readonly source: KeyMachine | null;
	/** Machines without a key, or with an older account key, that take the source's. */
	readonly targets: readonly KeyMachine[];
	/** Machines holding an account key set no later than its removal: it is removed and never handed on. */
	readonly stale: readonly KeyMachine[];
}

/** The machines this device can change the account's key on: linked now, on a tunelo that takes it. */
export function shareMachines(views: readonly MachineView[]): KeyMachine[] {
	return views.map((view) => ({ view, key: keyStateOf(view) })).filter((m) => m.key.reachable && m.key.share);
}

export function planKeySync(views: readonly MachineView[], removedAt: number): KeySyncPlan {
	const machines = shareMachines(views);
	const stale = machines.filter((m) => m.key.source === "account" && m.key.setAt <= removedAt);
	const live = machines.filter((m) => m.key.source === "account" && m.key.setAt > removedAt);
	const source = live.reduce<KeyMachine | null>((best, m) => (best === null || compareKeys(m.key, best.key) > 0 ? m : best), null);
	if (source === null) return { source, targets: [], stale };
	const targets = machines.filter(
		(m) => m !== source && (m.key.source === "none" || (m.key.source === "account" && m.key.setAt > removedAt && compareKeys(m.key, source.key) < 0)),
	);
	return { source, targets, stale };
}

/**
 * The set time of a new account key: now, and always after the last removal
 * and every account key in reach, so a slow clock here never makes it look
 * removed or older than the key it replaces.
 */
export function nextSetAt(now: number, removedAt: number, machines: readonly Pick<KeyMachine, "key">[]): number {
	return machines.reduce((at, m) => (m.key.source === "account" ? Math.max(at, m.key.setAt + 1) : at), Math.max(now, removedAt + 1));
}

/** The removal time to keep: now, and never before a key it removes (a fast clock elsewhere never keeps one alive). */
export function removalTime(now: number, machines: readonly Pick<KeyMachine, "key">[]): number {
	return machines.reduce((at, m) => (m.key.source === "account" ? Math.max(at, m.key.setAt) : at), now);
}

/** A machine answered something else than the hand-off expects. */
export class KeyHandOffError extends Error {
	constructor(step: string) {
		super(`the account's key hand-off stopped at ${step}`);
	}
}

/**
 * Hands the account's key from `source` to `target`: a ticket from the
 * target, the key sealed for it by the source, the sealed bytes back to the
 * target. Rejects with the machine's refusal or KeyHandOffError.
 */
export async function handOffAccountKey(source: MachineView, target: MachineView): Promise<void> {
	const ticket = await target.link.request({ case: "advisorKeyShareBegin", value: {} });
	if (ticket.body.case !== "advisorKeyShareTicket") throw new KeyHandOffError("the ticket");
	const { ticketId, publicKey } = ticket.body.value;
	const sealed = await source.link.request({ case: "advisorKeySeal", value: { recipientPublicKey: publicKey } });
	if (sealed.body.case !== "advisorKeySealed") throw new KeyHandOffError("sealing");
	const opened = await target.link.request({ case: "advisorKeyShareOpen", value: { ticketId, sealed: sealed.body.value.sealed } });
	if (opened.body.case !== "ack") throw new KeyHandOffError("opening");
}
