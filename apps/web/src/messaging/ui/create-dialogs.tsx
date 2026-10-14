// New chat, group, channel, adding members and forwarding (mockups
// chat.html#new-chat, #new-group, #new-channel, #forward).
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { fold, type DialogView } from "@app/core";
import { Icon } from "../../components/icon.tsx";
import { navigate, paths } from "../../router.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { chatKind, dialogTitle, messagePreview, userName } from "../data/format.ts";
import { Permission, type Person } from "../data/remote.ts";
import { useChat, useDialogOrder, useMessage, useServices, useUser } from "../data/services.tsx";
import { inviteLinks, isActiveInvite } from "./members.ts";
import { ChatAvatar, DialogHead, Modal, SoonTag, Switch, useDomId } from "./parts.tsx";
import { useUi } from "./ui-context.tsx";

const SEARCH_DELAY_MS = 250;

interface CloseProps {
	onClose: () => void;
}

interface Candidate {
	readonly id: number;
	readonly name: string;
	readonly detail: string;
	readonly isBot: boolean;
}

/** People search on the server, debounced; empty query gives no results. */
function usePeopleSearch(query: string): { people: Person[] | null; failed: boolean } {
	const { remote } = useServices();
	const [result, setResult] = useState<{ query: string; people: Person[]; failed: boolean } | null>(null);
	const clean = query.trim().replace(/^@/, "");
	useEffect(() => {
		if (clean === "") return;
		let active = true;
		const timer = setTimeout(() => {
			remote.searchPeople(clean).then(
				(people) => {
					if (active) setResult({ query: clean, people, failed: false });
				},
				() => {
					if (active) setResult({ query: clean, people: [], failed: true });
				},
			);
		}, SEARCH_DELAY_MS);
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [remote, clean]);
	if (clean === "" || result === null || result.query !== clean) return { people: null, failed: false };
	return { people: result.people, failed: result.failed };
}

export function NewChatDialog({ onClose }: CloseProps) {
	const copy = useScreensCopy();
	const ui = useUi();
	const { remote, toasts } = useServices();
	const [query, setQuery] = useState("");
	const [opening, setOpening] = useState(0);
	const { people } = usePeopleSearch(query);
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
	if (people !== null && people.length === 0) {
		results = (
			<div className="empty compact">
				<strong>{email ? copy.newChat.noEmailTitle : copy.newChat.noUserTitle}</strong>
				<span>{email ? copy.newChat.noEmailBody : copy.newChat.noUserBody}</span>
			</div>
		);
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
	const { people } = usePeopleSearch(query);
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
			{shown.length === 0 && query.trim() === "" && <p className="note">{copy.newGroup.noPeople}</p>}
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
			if (failedUserIds.length > 0) ui.dialog.set({ kind: "addFailed", chatId, userIds: failedUserIds });
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
	const add = () => {
		setBusy(true);
		remote.addMembers(chatId, [...selected.keys()]).then(
			(failed) => {
				const added = selected.size - failed.length;
				if (added > 0) toasts.show(copy.info.added(added));
				if (failed.length > 0) ui.dialog.set({ kind: "addFailed", chatId, userIds: failed });
				else onClose();
			},
			() => {
				setBusy(false);
				toasts.show(copy.common.failed);
			},
		);
	};
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={copy.info.addMembersTitle} onClose={onClose} />
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
				<div className="radio-cards" role="radiogroup" aria-label={copy.newChannel.kind}>
					<button type="button" className="radio-card" role="radio" aria-checked={false} aria-disabled="true" aria-describedby={`${id}-soon`}>
						<Icon name="globe" />
						<b>
							{copy.newChannel.public} <SoonTag id={`${id}-soon`} />
						</b>
						<small>{copy.newChannel.publicHint}</small>
					</button>
					<button type="button" className="radio-card" role="radio" aria-checked>
						<Icon name="lock" />
						<b>{copy.newChannel.private}</b>
						<small>{copy.newChannel.privateHint}</small>
					</button>
				</div>
				<div className="field">
					<span className="label">{copy.newChannel.inviteLink}</span>
					<span className="hint">{copy.newChannel.inviteHint}</span>
				</div>
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
	useChat(chatId);
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

	const send = async () => {
		setBusy(true);
		const text = comment.trim();
		try {
			for (const target of selected.keys()) {
				if (text !== "") await source.sendText(target, text);
				await remote.forward(chatId, [seq], target);
			}
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
						{messagePreview(message, nameOf, copy)}
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

/**
 * People the server did not add because of their "add me to groups" privacy
 * setting (only people who share a chat with them). Offers what still works:
 * send them an invite link in a private chat, or open a private chat.
 */
export function AddFailedDialog({ chatId, userIds, onClose }: CloseProps & { chatId: number; userIds: readonly number[] }) {
	const copy = useScreensCopy();
	const { remote, source, toasts } = useServices();
	const [people, setPeople] = useState<readonly Person[]>([]);
	const [busy, setBusy] = useState(0);
	const [sent, setSent] = useState<ReadonlySet<number>>(new Set());
	const id = useDomId("failed");
	useEffect(() => {
		let active = true;
		remote.people(userIds).then(
			(found) => {
				if (active) setPeople(found);
			},
			() => undefined,
		);
		return () => {
			active = false;
		};
	}, [remote, userIds]);

	const inviteLink = async (): Promise<string> => {
		const existing = inviteLinks.list(chatId).find((invite) => isActiveInvite(invite, Date.now()));
		if (existing !== undefined) return existing.link;
		const created = await remote.exportInvite(chatId, 0, 0);
		inviteLinks.add(chatId, created);
		return created.link;
	};
	const sendInvite = async (person: Person) => {
		setBusy(person.id);
		try {
			const link = await inviteLink();
			const privateChat = await remote.createPrivate(person.id);
			await source.sendText(privateChat, link);
			setSent((current) => new Set(current).add(person.id));
			toasts.show(copy.addFailed.inviteSent(person.name));
		} catch {
			toasts.show(copy.common.failed);
		} finally {
			setBusy(0);
		}
	};
	const message = (person: Person) => {
		setBusy(person.id);
		remote.createPrivate(person.id).then(
			(privateChat) => {
				onClose();
				navigate(paths.chat(privateChat));
			},
			() => {
				setBusy(0);
				toasts.show(copy.common.failed);
			},
		);
	};
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={copy.addFailed.title(userIds.length)} onClose={onClose} />
			<div className="dlg-body stack">
				<p className="note">
					<Icon name="shield" />
					<span>{copy.addFailed.note}</span>
				</p>
				<div className="result-list">
					{people.map((person) => (
						<div className="result" key={person.id}>
							<ChatAvatar id={person.id} name={person.name} bot={person.isBot} />
							<span>
								<b>{person.name}</b>
								{person.username !== "" && <small>@{person.username}</small>}
								{sent.has(person.id) && (
									<span className="match">
										<Icon name="check" />
										{copy.addFailed.inviteSent(person.name)}
									</span>
								)}
							</span>
							<span className="result-actions">
								<button type="button" className="btn btn-primary btn-sm" aria-busy={busy === person.id} disabled={busy !== 0} onClick={() => void sendInvite(person)}>
									{copy.addFailed.sendInvite}
								</button>
								<button type="button" className="btn btn-sm" disabled={busy !== 0} onClick={() => message(person)}>
									{copy.addFailed.message}
								</button>
							</span>
						</div>
					))}
				</div>
			</div>
			<div className="dlg-foot">
				<button type="button" className="btn" onClick={onClose}>
					{copy.common.done}
				</button>
			</div>
		</Modal>
	);
}
