// New chat, group, channel, adding members and its result, and forwarding
// (mockups chat.html#new-chat, #new-group, #new-channel, #add-members,
// #forward).
import { Code, ConnectError } from "@connectrpc/connect";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { fold, type DialogView } from "@app/core";
import { brand } from "../../brand.ts";
import { Icon } from "../../components/icon.tsx";
import { navigate, paths } from "../../router.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { chatKind, dialogTitle, joinNames, messagePreview, userName } from "../data/format.ts";
import { Permission, type Person } from "../data/remote.ts";
import { useChat, useDialogOrder, useMessage, useServices, useUser } from "../data/services.tsx";
import { inviteLinks, isActiveInvite } from "./members.ts";
import { isOwnAccount, usePeopleSearch } from "./people-search.ts";
import { ContactsGlyph } from "./contacts-glyph.tsx";
import { ChatAvatar, copyText, DialogHead, Modal, Switch, useDomId } from "./parts.tsx";
import { useUi } from "./ui-context.tsx";

interface CloseProps {
	onClose: () => void;
}

/**
 * A people search that found nobody: the user's own account (the server
 * never returns it), or someone who has not signed in yet or cannot be found.
 */
function NoPeopleFound({ query }: { query: string }) {
	const copy = useScreensCopy();
	const { self } = useServices();
	if (isOwnAccount(query, self)) {
		return (
			<div className="empty compact">
				<Icon name="user" />
				<strong>{copy.newChat.selfTitle}</strong>
			</div>
		);
	}
	return (
		<div className="empty compact">
			<Icon name="search" />
			<strong>{copy.newChat.noneTitle}</strong>
			<span>{copy.newChat.noneBody(brand.webHost)}</span>
		</div>
	);
}

interface Candidate {
	readonly id: number;
	readonly name: string;
	readonly detail: string;
	readonly isBot: boolean;
}

export function NewChatDialog({ onClose }: CloseProps) {
	const copy = useScreensCopy();
	const ui = useUi();
	const { remote, toasts } = useServices();
	const [query, setQuery] = useState("");
	const [opening, setOpening] = useState(0);
	const { people, failed } = usePeopleSearch(query);
	const id = useDomId("nc");
	const email = query.includes("@") && !query.trim().startsWith("@");

	const open = (person: Person) => {
		setOpening(person.id);
		remote.createPrivate(person.id).then(
			(chatId) => {
				onClose();
				navigate(paths.chat(chatId));
			},
			() => {
				setOpening(0);
				toasts.show(copy.common.failed);
			},
		);
	};

	let results: ReactNode = null;
	if (failed) {
		results = <p className="note">{copy.common.loadFailed}</p>;
	} else if (people !== null && people.length === 0) {
		results = <NoPeopleFound query={query} />;
	} else if (people !== null) {
		results = (
			<div className="result-list">
				{people.map((person) => (
					<div className="result" key={person.id}>
						<ChatAvatar id={person.id} name={person.name} bot={person.isBot} />
						<span>
							<b>{person.name}</b>
							{person.username !== "" && <small>@{person.username}</small>}
							<span className="match">
								<Icon name="check" />
								{email ? copy.newChat.matchEmail : copy.newChat.matchUsername}
							</span>
						</span>
						<button type="button" className="btn btn-primary btn-sm" aria-busy={opening === person.id} disabled={opening !== 0} onClick={() => open(person)}>
							{copy.newChat.message}
						</button>
					</div>
				))}
			</div>
		);
	}

	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={copy.newChat.title} onClose={onClose} />
			<div className="dlg-body stack">
				<div className="quick">
					<button type="button" onClick={() => ui.dialog.set({ kind: "newGroup" })}>
						<Icon name="users" />
						{copy.newChat.newGroup}
					</button>
					<button type="button" onClick={() => ui.dialog.set({ kind: "newChannel" })}>
						<Icon name="megaphone" />
						{copy.newChat.newChannel}
					</button>
					<button
						type="button"
						onClick={() => {
							onClose();
							navigate(paths.contacts());
						}}
					>
						<ContactsGlyph />
						{copy.contacts.title}
					</button>
				</div>
				<div className="field">
					<label htmlFor={`${id}-q`}>{copy.newChat.findPeople}</label>
					<span className="search-field">
						<Icon name="search" small />
						<input
							id={`${id}-q`}
							type="search"
							placeholder={copy.newChat.placeholder}
							autoComplete="off"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
						/>
					</span>
				</div>
				<div aria-live="polite">{results}</div>
				<p className="note">
					<Icon name="shield" />
					<span>{copy.newChat.note}</span>
				</p>
			</div>
		</Modal>
	);
}

/** People from your private chats: the default list of the member picker. */
function useRecentPeople(): Candidate[] {
	const { store } = useServices();
	const order = useDialogOrder();
	return useMemo(() => {
		const people: Candidate[] = [];
		for (const chatId of order) {
			const view = store.dialog(chatId);
			const peer = view?.peer;
			if (view?.chat?.type !== "private" || peer == null || peer.isSelf) continue;
			people.push({ id: peer.id, name: peer.name, detail: peer.username === "" ? "" : `@${peer.username}`, isBot: peer.isBot });
		}
		return people;
	}, [order, store]);
}

interface PickerProps {
	selected: ReadonlyMap<number, Candidate>;
	onToggle: (candidate: Candidate) => void;
	exclude?: ReadonlySet<number>;
}

function PeoplePicker({ selected, onToggle, exclude }: PickerProps) {
	const copy = useScreensCopy();
	const [query, setQuery] = useState("");
	const recent = useRecentPeople();
	const { people, failed } = usePeopleSearch(query);
	const searching = query.trim() !== "";
	const candidates: Candidate[] =
		query.trim() === ""
			? recent
			: (people ?? []).map((p) => ({ id: p.id, name: p.name, detail: p.isBot ? copy.newGroup.bot : p.username === "" ? "" : `@${p.username}`, isBot: p.isBot }));
	const shown = candidates.filter((c) => exclude?.has(c.id) !== true);
	return (
		<>
			<label className="search-field">
				<Icon name="search" small />
				<span className="sr-only">{copy.newChat.findPeople}</span>
				<input type="search" placeholder={copy.newGroup.search} autoComplete="off" value={query} onChange={(event) => setQuery(event.target.value)} />
			</label>
			<Chips items={[...selected.values()]} onRemove={onToggle} />
			<div className="pick-list" role="group" aria-label={copy.newGroup.members}>
				{shown.map((candidate) => (
					<button
						key={candidate.id}
						type="button"
						className="pick"
						role="checkbox"
						aria-checked={selected.has(candidate.id)}
						onClick={() => onToggle(candidate)}
					>
						<ChatAvatar id={candidate.id} name={candidate.name} bot={candidate.isBot} />
						<span>
							<b>{candidate.name}</b>
							{candidate.detail !== "" && <small>{candidate.detail}</small>}
						</span>
						<span className="tick">
							<Icon name="check" />
						</span>
					</button>
				))}
			</div>
			<div aria-live="polite">
				{!searching && shown.length === 0 && <p className="note">{copy.newGroup.noPeople}</p>}
				{searching && failed && <p className="note">{copy.common.loadFailed}</p>}
				{searching && !failed && people !== null && shown.length === 0 && <NoPeopleFound query={query} />}
			</div>
		</>
	);
}

function Chips({ items, onRemove }: { items: readonly Candidate[]; onRemove: (item: Candidate) => void }) {
	const copy = useScreensCopy();
	return (
		<div className="chips" aria-live="polite">
			{items.map((item) => (
				<button key={item.id} type="button" className="chip" aria-label={copy.forward.unselect(item.name)} onClick={() => onRemove(item)}>
					<ChatAvatar id={item.id} name={item.name} size="xs" bot={item.isBot} />
					{item.name}
					<Icon name="x" />
				</button>
			))}
		</div>
	);
}

function useSelection(): [ReadonlyMap<number, Candidate>, (candidate: Candidate) => void] {
	const [selected, setSelected] = useState<ReadonlyMap<number, Candidate>>(new Map());
	const toggle = (candidate: Candidate) =>
		setSelected((current) => {
			const next = new Map(current);
			if (next.has(candidate.id)) next.delete(candidate.id);
			else next.set(candidate.id, candidate);
			return next;
		});
	return [selected, toggle];
}

export function NewGroupDialog({ onClose }: CloseProps) {
	const copy = useScreensCopy();
	const ui = useUi();
	const { remote, self, toasts } = useServices();
	const [selected, toggle] = useSelection();
	const [step, setStep] = useState<1 | 2>(1);
	const [name, setName] = useState("");
	const [history, setHistory] = useState(true);
	const [busy, setBusy] = useState(false);
	const [invalid, setInvalid] = useState(false);
	const id = useDomId("ng");

	const create = async () => {
		const title = name.trim();
		if (title === "") {
			setInvalid(true);
			return;
		}
		setBusy(true);
		try {
			const { chatId, failedUserIds } = await remote.createGroup(title, [...selected.keys()]);
			if (!history) await remote.setHistoryShared(chatId, false).catch(() => undefined);
			toasts.show(copy.newGroup.created(title));
			navigate(paths.chat(chatId));
			if (failedUserIds.length > 0) {
				const added = [...selected.keys()].filter((userId) => !failedUserIds.includes(userId));
				ui.dialog.set({ kind: "addFailed", chatId, userIds: failedUserIds, addedIds: added });
			}
			else onClose();
		} catch {
			setBusy(false);
			toasts.show(copy.common.failed);
		}
	};

	if (step === 1) {
		return (
			<Modal labelledBy={id} onClose={onClose}>
				<DialogHead id={id} title={copy.newGroup.title} step={copy.newGroup.step(1)} onClose={onClose} />
				<div className="dlg-body stack">
					<PeoplePicker selected={selected} onToggle={toggle} />
				</div>
				<div className="dlg-foot">
					<button type="button" className="btn" onClick={onClose}>
						{copy.common.cancel}
					</button>
					<button type="button" className="btn btn-primary" disabled={selected.size === 0} onClick={() => setStep(2)}>
						{copy.newGroup.next(selected.size)}
					</button>
				</div>
			</Modal>
		);
	}
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={copy.newGroup.title} step={copy.newGroup.step(2)} onBack={() => setStep(1)} />
			<div className="dlg-body stack">
				<div className="field">
					<label htmlFor={`${id}-name`}>{copy.newGroup.name}</label>
					<input
						id={`${id}-name`}
						className="input"
						maxLength={128}
						value={name}
						aria-invalid={invalid}
						aria-describedby={invalid ? `${id}-err` : undefined}
						onChange={(event) => {
							setName(event.target.value);
							setInvalid(false);
						}}
					/>
					{invalid && (
						<span className="error-text" id={`${id}-err`}>
							{copy.newGroup.nameRequired}
						</span>
					)}
				</div>
				<div className="row">
					<span className="grow">
						{copy.newGroup.history}
						<small>{copy.newGroup.historyHint}</small>
					</span>
					<Switch checked={history} label={copy.newGroup.history} onChange={setHistory} />
				</div>
				<div>
					<h3>{copy.newGroup.memberCount(selected.size + 1)}</h3>
					<div className="row">
						<ChatAvatar id={self.id} name={self.name} size="sm" />
						<span className="grow">{copy.common.you}</span>
						<span className="role">{copy.newGroup.creator}</span>
					</div>
					{[...selected.values()].map((candidate) => (
						<div className="row" key={candidate.id}>
							<ChatAvatar id={candidate.id} name={candidate.name} size="sm" bot={candidate.isBot} />
							<span className="grow">{candidate.name}</span>
						</div>
					))}
				</div>
			</div>
			<div className="dlg-foot">
				<button type="button" className="btn" onClick={() => setStep(1)}>
					{copy.common.back}
				</button>
				<button type="button" className="btn btn-primary" aria-busy={busy} disabled={busy} onClick={() => void create()}>
					{copy.newGroup.create}
				</button>
			</div>
		</Modal>
	);
}

export function AddMembersDialog({ chatId, onClose }: CloseProps & { chatId: number }) {
	const copy = useScreensCopy();
	const ui = useUi();
	const { remote, toasts } = useServices();
	const [selected, toggle] = useSelection();
	const [busy, setBusy] = useState(false);
	const id = useDomId("add");
	const channel = useChat(chatId)?.type === "channel";
	const add = () => {
		setBusy(true);
		remote.addMembers(chatId, [...selected.keys()]).then(
			(failed) => {
				const added = [...selected.keys()].filter((userId) => !failed.includes(userId));
				if (failed.length > 0) {
					ui.dialog.set({ kind: "addFailed", chatId, userIds: failed, addedIds: added });
					return;
				}
				toasts.show(copy.info.added(added.length));
				onClose();
			},
			() => {
				setBusy(false);
				toasts.show(copy.common.failed);
			},
		);
	};
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={copy.info.addMembersTitle(channel)} onClose={onClose} />
			<div className="dlg-body stack">
				<PeoplePicker selected={selected} onToggle={toggle} />
			</div>
			<div className="dlg-foot">
				<button type="button" className="btn" onClick={onClose}>
					{copy.common.cancel}
				</button>
				<button type="button" className="btn btn-primary" aria-busy={busy} disabled={selected.size === 0 || busy} onClick={add}>
					{copy.info.add(selected.size)}
				</button>
			</div>
		</Modal>
	);
}

export function NewChannelDialog({ onClose }: CloseProps) {
	const copy = useScreensCopy();
	const { remote, toasts } = useServices();
	const [name, setName] = useState("");
	const [about, setAbout] = useState("");
	const [busy, setBusy] = useState(false);
	const [invalid, setInvalid] = useState(false);
	const id = useDomId("ch");
	const create = async () => {
		const title = name.trim();
		if (title === "") {
			setInvalid(true);
			return;
		}
		setBusy(true);
		try {
			const chatId = await remote.createChannel(title, about.trim());
			const invite = await remote.exportInvite(chatId, 0, 0).catch(() => null);
			if (invite !== null) inviteLinks.add(chatId, invite);
			toasts.show(copy.newChannel.created(title));
			onClose();
			navigate(paths.chat(chatId));
		} catch {
			setBusy(false);
			toasts.show(copy.common.failed);
		}
	};
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={copy.newChannel.title} onClose={onClose} />
			<div className="dlg-body stack">
				<div className="field">
					<label htmlFor={`${id}-name`}>{copy.newChannel.name}</label>
					<input
						id={`${id}-name`}
						className="input"
						maxLength={128}
						value={name}
						aria-invalid={invalid}
						onChange={(event) => {
							setName(event.target.value);
							setInvalid(false);
						}}
					/>
					{invalid && <span className="error-text">{copy.newChannel.nameRequired}</span>}
				</div>
				<div className="field">
					<label htmlFor={`${id}-about`}>{copy.newChannel.description}</label>
					<textarea id={`${id}-about`} className="input" rows={2} value={about} onChange={(event) => setAbout(event.target.value)} />
				</div>
				<p className="note">
					<Icon name="link" />
					<span>{copy.newChannel.inviteHint}</span>
				</p>
			</div>
			<div className="dlg-foot">
				<button type="button" className="btn" onClick={onClose}>
					{copy.common.cancel}
				</button>
				<button type="button" className="btn btn-primary" aria-busy={busy} disabled={busy} onClick={() => void create()}>
					{copy.newChannel.create}
				</button>
			</div>
		</Modal>
	);
}

function canPost(view: DialogView): boolean {
	const chat = view.chat;
	if (chat === null || chat.left) return false;
	const admin = chat.myRole === "admin" || chat.myRole === "owner";
	if (chat.type === "channel") return admin;
	if (chat.type === "group") return admin || (chat.myPermissions & Permission.sendMessages) !== 0;
	return true;
}

export function ForwardDialog({ chatId, seq, onClose }: CloseProps & { chatId: number; seq: number }) {
	const copy = useScreensCopy();
	const { remote, source, store, toasts } = useServices();
	const order = useDialogOrder();
	const message = useMessage(chatId, seq);
	const author = useUser(message != null && message.fromId !== store.selfId ? message.fromId : 0);
	const channel = useChat(chatId)?.type === "channel";
	const [query, setQuery] = useState("");
	const [selected, toggle] = useSelection();
	const [comment, setComment] = useState("");
	const [busy, setBusy] = useState(false);
	const id = useDomId("fw");

	const targets = useMemo(
		() =>
			order.flatMap((target) => {
				const view = store.dialog(target);
				if (view === undefined || !canPost(view)) return [];
				const kind = chatKind(view.chat, view.peer, false);
				const detail =
					kind === "group" ? copy.forward.groupMembers(view.chat?.memberCount ?? 0) : kind === "channel" ? copy.forward.channel : copy.forward.privateChat;
				return [{ id: target, name: dialogTitle(view, copy), detail, isBot: kind === "bot" }];
			}),
		[order, store, copy],
	);
	const needle = fold(query);
	const shown = targets.filter((target) => needle === "" || fold(target.name).includes(needle));

	const forwardAll = async (text: string) => {
		for (const target of selected.keys()) {
			if (text !== "") await source.sendText(target, text);
			await remote.forward(chatId, [seq], target);
		}
	};
	const send = async () => {
		setBusy(true);
		try {
			await forwardAll(comment.trim());
			toasts.show(copy.forward.done);
			onClose();
		} catch {
			setBusy(false);
			toasts.show(copy.common.failed);
		}
	};

	const nameOf = (id: number) => userName(store.user(id), store.selfId, copy, id);
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={copy.forward.title} onClose={onClose} />
			<div className="dlg-body stack">
				{message != null && (
					<div className="quote">
						<b>{message.fromId === store.selfId ? copy.common.you : (author?.name ?? copy.message.unknownUser)}</b>
						{messagePreview(message, nameOf, copy, channel)}
					</div>
				)}
				<label className="search-field">
					<Icon name="search" small />
					<span className="sr-only">{copy.forward.search}</span>
					<input type="search" placeholder={copy.forward.search} autoComplete="off" value={query} onChange={(event) => setQuery(event.target.value)} />
				</label>
				<Chips items={[...selected.values()]} onRemove={toggle} />
				<div className="pick-list" role="group" aria-label={copy.forward.targets}>
					{shown.map((target) => (
						<button key={target.id} type="button" className="pick" role="checkbox" aria-checked={selected.has(target.id)} onClick={() => toggle(target)}>
							<ChatAvatar id={target.id} name={target.name} bot={target.isBot} />
							<span>
								<b>{target.name}</b>
								<small>{target.detail}</small>
							</span>
							<span className="tick">
								<Icon name="check" />
							</span>
						</button>
					))}
				</div>
				{shown.length === 0 && (
					<div className="empty compact">
						<strong>{copy.forward.emptyTitle}</strong>
						<span>{copy.forward.emptyBody}</span>
					</div>
				)}
				<div className="field">
					<label htmlFor={`${id}-comment`}>{copy.forward.comment}</label>
					<textarea
						id={`${id}-comment`}
						className="input"
						rows={2}
						placeholder={copy.forward.commentPlaceholder}
						value={comment}
						onChange={(event) => setComment(event.target.value)}
					/>
				</div>
			</div>
			<div className="dlg-foot">
				<button type="button" className="btn" onClick={onClose}>
					{copy.common.cancel}
				</button>
				<button type="button" className="btn btn-primary" aria-busy={busy} disabled={selected.size === 0 || busy} onClick={() => void send()}>
					{copy.forward.send(selected.size)}
				</button>
			</div>
		</Modal>
	);
}

/** Where an invite to one person stands in the add-members result. */
type InviteState = "idle" | "sending" | "sent" | "refused";

interface AddFailedProps extends CloseProps {
	chatId: number;
	userIds: readonly number[];
	addedIds: readonly number[];
}

/**
 * The add-members result (#add-members): who was added, and for each person
 * the server refused (their "add me to groups" privacy, or a ban from the
 * chat) what still works: an invite link sent in a private chat, or a private
 * chat. When their "message me" setting refuses you too, the link is copied
 * for you to send another way. The server gives no reason per person, so the
 * row names the possible ones.
 */
export function AddFailedDialog({ chatId, userIds, addedIds, onClose }: AddFailedProps) {
	const copy = useScreensCopy();
	const { remote, source, toasts } = useServices();
	const chat = useChat(chatId);
	const [people, setPeople] = useState<readonly Person[]>([]);
	const [added, setAdded] = useState<readonly Person[]>([]);
	const [invites, setInvites] = useState<ReadonlyMap<number, InviteState>>(new Map());
	const id = useDomId("failed");
	const t = copy.addFailed;
	const title = chat?.title ?? "";
	// Admins adding a banned user lift the ban, so for them only privacy refuses.
	const admin = chat?.myRole === "admin" || chat?.myRole === "owner";
	const channel = chat?.type === "channel";

	useEffect(() => {
		let active = true;
		remote.people([...userIds, ...addedIds]).then(
			(found) => {
				if (!active) return;
				setPeople(found.filter((person) => userIds.includes(person.id)));
				setAdded(found.filter((person) => addedIds.includes(person.id)));
			},
			() => undefined,
		);
		return () => {
			active = false;
		};
	}, [remote, userIds, addedIds]);

	const setInvite = (userId: number, state: InviteState) => setInvites((current) => new Map(current).set(userId, state));
	const inviteLink = async (): Promise<string> => {
		const existing = inviteLinks.list(chatId).find((invite) => isActiveInvite(invite, Date.now()));
		if (existing !== undefined) return existing.link;
		const created = await remote.exportInvite(chatId, 0, 0);
		inviteLinks.add(chatId, created);
		return created.link;
	};
	const sendInvite = async (person: Person): Promise<void> => {
		setInvite(person.id, "sending");
		try {
			const link = await inviteLink();
			const privateChat = await remote.createPrivate(person.id);
			await source.sendText(privateChat, link);
			setInvite(person.id, "sent");
			toasts.show(t.inviteSentToast(person.name));
		} catch (err) {
			// Their "message me" privacy refuses a private chat with you.
			const refused = ConnectError.from(err).code === Code.PermissionDenied;
			setInvite(person.id, refused ? "refused" : "idle");
			if (!refused) toasts.show(copy.common.failed);
		}
	};
	const copyLink = async () => {
		const ok = await inviteLink().then(copyText, () => false);
		toasts.show(ok ? t.copied(title) : copy.common.failed);
	};
	const message = (person: Person) => {
		remote.createPrivate(person.id).then(
			(privateChat) => {
				onClose();
				navigate(paths.chat(privateChat));
			},
			() => toasts.show(copy.common.failed),
		);
	};
	const pending = people.filter((person) => (invites.get(person.id) ?? "idle") === "idle");
	const busy = [...invites.values()].includes("sending");
	const sendAll = async () => {
		for (const person of pending) await sendInvite(person);
	};

	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={t.title(userIds.length)} onClose={onClose} />
			<div className="dlg-body stack">
				{added.length > 0 && (
					<p className="note ok">
						<Icon name="check" />
						<span>{t.added(joinNames(added.map((person) => person.name), copy.system.and), title)}</span>
					</p>
				)}
				<ul className="fail-list">
					{people.map((person) => {
						const state = invites.get(person.id) ?? "idle";
						const whyId = `${id}-why-${person.id}`;
						return (
							<li key={person.id}>
								<div className="row">
									<ChatAvatar id={person.id} name={person.name} bot={person.isBot} />
									<span className="grow">
										{person.name}
										<small>{admin ? t.reason(person.name, channel) : t.reasonMaybeBanned(person.name, channel)}</small>
									</span>
								</div>
								<div className="pick-actions" role="group" aria-label={t.otherWays(person.name)} aria-describedby={state === "refused" ? whyId : undefined}>
									<button
										type="button"
										className="btn btn-compact"
										aria-busy={state === "sending"}
										disabled={state !== "idle" || busy}
										onClick={() => void sendInvite(person)}
									>
										<Icon name={state === "sent" ? "check" : "link"} />
										{t.sendInvite}
									</button>
									{state === "refused" ? (
										<button type="button" className="btn btn-compact" onClick={() => void copyLink()}>
											<Icon name="copy" />
											{t.copyLink}
										</button>
									) : (
										<button type="button" className="btn btn-compact" disabled={busy} onClick={() => message(person)}>
											<Icon name="message" />
											{t.message}
										</button>
									)}
								</div>
								{state === "sent" && (
									<p className="why">
										<Icon name="check" />
										{t.inviteSent(person.name)}
									</p>
								)}
								{state === "refused" && (
									<p className="why" id={whyId}>
										<Icon name="lock" />
										{t.cantSend(person.name)}
									</p>
								)}
							</li>
						);
					})}
				</ul>
			</div>
			<div className="dlg-foot">
				<button type="button" className="btn" onClick={onClose}>
					{copy.common.done}
				</button>
				{pending.length > 0 && (
					<button type="button" className="btn btn-primary" aria-busy={busy} disabled={busy} onClick={() => void sendAll()}>
						<Icon name="link" />
						{t.sendAll(pending.length)}
					</button>
				)}
			</div>
		</Modal>
	);
}
