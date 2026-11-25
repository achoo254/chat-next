// «Liên hệ» of AI Agent: the people and groups of Chat (linked people as one
// row over all their one-to-one chats, any other one-to-one chat, groups),
// searchable. Each row opens the chat's own session on the machine (the
// session of the conversation's AI panel), opens it with the composer ready
// for a message to that person («Nhắn nhanh»), and turns on whether the
// chat's new messages go into that session («Đẩy tin vào phiên», tunelo
// 3.28.0+), with a limit of turns an hour and what the machine says of it.
// Subscriptions live on the machine picked here (the one the AI panel uses
// by default); its pushed state keeps the counters current.
import { useEffect, useId, useMemo, useState } from "react";
import type { ChatInboxItem } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../components/screen-icons.tsx";
import { advisorStore } from "../advisor/advisor-store.ts";
import { brand } from "../brand.ts";
import { appName } from "../messaging/data/format.ts";
import { useDialogOrder, useServices } from "../messaging/data/services.tsx";
import { usePeople } from "../messaging/people/people-store.ts";
import { ChatAvatar, Switch } from "../messaging/ui/parts.tsx";
import { CONTEXT_ONLY, chatContext, chatThread, createChatThread, pickTarget, rememberMachine, rememberedMachine } from "../messaging/ui/use-chat-ai.ts";
import { Link, navigate, paths } from "../router.tsx";
import { AGENT_CHAT_INBOX, AGENT_CHAT_THREADS, versionAtLeast } from "./agent-version.ts";
import { aiPaths } from "./ai-paths.ts";
import { contactRows, DEFAULT_LIMIT, inboxSets, LIMITS, matchRows, rowApps, rowEnabled, rowLimit, rowStatus, type ContactChat, type ContactRow, type RowStatus } from "./contacts-model.ts";
import type { MachinesCopy } from "./copy-vi.ts";
import { PageHead } from "./page-head.tsx";
import { errorText, useHub, useMachineViews, useNow, type MachineView } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

/** What the picked machine allows: pushing (tunelo 3.28.0+) and chat sessions (3.27.0+), both only while it answers. */
interface Abilities {
	readonly inbox: boolean;
	readonly sessions: boolean;
}

export function statusText(t: MachinesCopy, status: RowStatus): string {
	const s = t.contacts.status;
	switch (status.kind) {
		case "off":
			return "";
		case "paused":
			return s.paused;
		case "active":
			return s.active(status.delivered);
		case "hidden":
			return s.hidden;
		case "limited":
			return s.limited(status.missed);
		case "error":
			return s.error;
		case "signedOut":
			return s.signedOut;
	}
}

export default function ContactsPage() {
	const t = useMachinesCopy();
	const c = t.contacts;
	const { store, self } = useServices();
	const order = useDialogOrder();
	const [, people] = usePeople(null);
	const hub = useHub();
	const views = useMachineViews(hub, useNow());
	const [picked, setPicked] = useState(() => rememberedMachine(self.id));
	const targetRef = pickTarget(views, picked);
	const target = views.find((v) => v.entry.ref === targetRef) ?? null;
	const [query, setQuery] = useState("");
	const searchId = useId();

	const rows = useMemo(() => contactRows(order, (id) => store.dialog(id), people.people, self.id), [order, store, people.people, self.id]);
	const shown = matchRows(rows, query);
	const info = target?.state.info ?? null;
	const online = target !== null && target.conn.kind === "on" && info !== null;
	const version = online && info !== null ? info.agentVersion : "";
	const abilities: Abilities = {
		inbox: versionAtLeast(version, AGENT_CHAT_INBOX),
		sessions: versionAtLeast(version, AGENT_CHAT_THREADS),
	};
	const items: readonly ChatInboxItem[] = abilities.inbox ? (target?.state.chatInbox ?? []) : [];

	// The machine's subscriptions, once it can say; later changes come pushed.
	const link = target?.link ?? null;
	useEffect(() => {
		if (link !== null && abilities.inbox) link.request({ case: "chatInboxList", value: {} }).catch(() => undefined);
	}, [link, abilities.inbox]);

	const pick = (ref: string) => {
		setPicked(ref);
		rememberMachine(self.id, ref);
	};

	return (
		<div className="mx-scroll mx-contacts">
			<PageHead back={paths.machines()} backLabel={t.backToMachines} title={c.title}>
				{views.length > 1 && target !== null && (
					<select className="input mx-contacts-machine" aria-label={c.machine} title={target.entry.name} value={target.entry.ref} onChange={(event) => pick(event.target.value)}>
						{views.map((v) => (
							<option key={v.entry.ref} value={v.entry.ref}>
								{v.entry.name}
							</option>
						))}
					</select>
				)}
			</PageHead>
			<div className="mx-body">
				<MachineNote t={t} target={target} online={online} abilities={abilities} />
				<label className="mx-contacts-search" htmlFor={searchId}>
					<Icon name="search" small />
					<input id={searchId} className="input" type="search" placeholder={c.search} aria-label={c.search} value={query} onChange={(event) => setQuery(event.target.value)} />
				</label>
				{rows.length === 0 ? (
					<p className="muted">{c.empty}</p>
				) : shown.length === 0 ? (
					<p className="muted">{c.noMatch}</p>
				) : (
					<ul className="mx-contact-rows" aria-label={c.title}>
						{shown.map((row) => (
							<ContactItem key={row.key} row={row} items={items} target={target} abilities={abilities} t={t} />
						))}
					</ul>
				)}
			</div>
		</div>
	);
}

/** Why the controls are off: no machine, the machine is off, or its tunelo is too old to push. */
function MachineNote({ t, target, online, abilities }: { t: MachinesCopy; target: MachineView | null; online: boolean; abilities: Abilities }) {
	const c = t.contacts;
	if (target === null) {
		return (
			<p className="note" role="status">
				{c.noMachine} <Link to={aiPaths.manage}>{c.manage}</Link>
			</p>
		);
	}
	if (!online) {
		return (
			<p className="note" role="status">
				{c.offline(target.entry.name)}
			</p>
		);
	}
	if (!abilities.inbox) {
		return (
			<p className="note" role="status" data-id="contacts-outdated">
				{c.outdated} <Link to={paths.machineInfo(target.entry.ref)}>{c.update}</Link>
			</p>
		);
	}
	return null;
}

function AppBadges({ row }: { row: ContactRow }) {
	return (
		<span className="mx-contact-apps">
			{rowApps(row).map((app) => (
				<span key={app} className="mx-tag" data-app={app === "" ? "chat" : app}>
					{app === "" ? brand.appName : appName(app)}
				</span>
			))}
		</span>
	);
}

function ContactItem({ row, items, target, abilities, t }: { row: ContactRow; items: readonly ChatInboxItem[]; target: MachineView | null; abilities: Abilities; t: MachinesCopy }) {
	const c = t.contacts;
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const enabled = rowEnabled(row, items);
	const limit = rowLimit(row, items);
	const status = statusText(t, rowStatus(row, items));
	const hidden = row.chats.some((chat) => chat.hiddenFromAi);
	const first: ContactChat | undefined = row.chats[0];
	const limitId = useId();
	const ai = target === null ? "AI" : (target.state.info?.providers[0]?.name ?? "AI");

	const fail = (err: unknown) => setError(errorText(t, err, ai));
	/** Sends one ChatInboxSet per chat of the row, in order; the machine answers each with every item. */
	const setInbox = async (on: boolean, perHourLimit: number) => {
		if (target === null) return;
		setBusy(true);
		setError("");
		try {
			for (const value of inboxSets(row, on, perHourLimit)) await target.link.request({ case: "chatInboxSet", value });
		} catch (err) {
			fail(err);
		} finally {
			setBusy(false);
		}
	};

	/**
	 * The row's session on the machine, then shown: the session one of its chats has (a person's newest chat first),
	 * else one opened for its newest chat with that chat's context.
	 */
	const openSession = async (quick: boolean) => {
		if (target === null || first === undefined) return;
		setBusy(true);
		setError("");
		try {
			const chat = first.app === "" ? { id: first.chatId } : { id: first.chatId, externalApp: first.app };
			const found = row.chats.map((chat) => chatThread(target.state.threads, chat.chatId)).find((thread) => thread !== null) ?? null;
			const thread = found ?? (await createChatThread(target.link, target.state, chat, first.title, `${chatContext(chat, first.title)}\n\n${CONTEXT_ONLY}`));
			if (thread === null || thread.chatId === 0n) throw new Error(c.failed);
			if (quick) advisorStore.fill(target.entry.ref, thread.id, c.quickPrefix(row.name));
			navigate(paths.machineSession(target.entry.ref, thread.id));
		} catch (err) {
			if (err instanceof Error && err.message === c.failed) setError(c.failed);
			else fail(err);
		} finally {
			setBusy(false);
		}
	};

	return (
		<li className="mx-contact" data-key={row.key}>
			<ChatAvatar id={first?.chatId ?? 0} name={row.name} />
			<div className="mx-contact-main">
				<div className="mx-contact-name">
					<b>{row.name}</b>
					{row.group && <span className="mx-tag">{c.group}</span>}
					<AppBadges row={row} />
				</div>
				{hidden && <small className="mx-contact-hidden">{c.hidden}</small>}
				{status !== "" && (
					<small className={`mx-contact-status ${rowStatus(row, items).kind}`} role="status">
						{status}
					</small>
				)}
				{error !== "" && (
					<small className="mx-error" role="alert">
						{error}
					</small>
				)}
			</div>
			<div className="mx-contact-acts">
				<span className="mx-contact-push">
					{/* Both words are visible text only; the switch's own name is the full sentence. */}
					<span className="mx-contact-push-long" aria-hidden="true">
						{c.push}
					</span>
					<span className="mx-contact-push-short" aria-hidden="true">
						{c.pushShort}
					</span>
					<Switch checked={enabled} label={c.pushFor(row.name)} disabled={!abilities.inbox || hidden || busy} onChange={(on) => void setInbox(on, on ? limit : 0)} />
				</span>
				{enabled && abilities.inbox && (
					<select id={limitId} className="input mx-contact-limit" aria-label={c.limit} value={limit} disabled={busy} onChange={(event) => void setInbox(true, Number(event.target.value) || DEFAULT_LIMIT)}>
						{[...new Set([...LIMITS, limit])].map((n) => (
							<option key={n} value={n}>
								{c.perHour(n)}
							</option>
						))}
					</select>
				)}
				<button type="button" className="btn btn-sm" disabled={!abilities.sessions || busy} onClick={() => void openSession(false)}>
					{c.open}
				</button>
				<button type="button" className="btn btn-sm" disabled={!abilities.sessions || busy} onClick={() => void openSession(true)}>
					{c.quick}
				</button>
			</div>
		</li>
	);
}
