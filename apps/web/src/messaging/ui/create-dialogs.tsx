// New chat, group, channel, adding members and its result, and forwarding
// (mockups chat.html#new-chat, #new-group, #new-channel, #add-members,
// #forward).
import { Code, ConnectError } from "@connectrpc/connect";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { fold, type DialogView } from "@app/core";
import { brand } from "../../brand.ts";
import { Icon } from "../../components/screen-icons.tsx";
import { MiddleTruncate } from "../../components/middle-truncate.tsx";
import { navigate, paths } from "../../router.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import type { FullCopy } from "../copy/use-screens-copy.ts";
import { useContacts } from "../data/contacts.ts";
import { chatKind, dialogTitle, joinNames, messagePreview, namedUserIds } from "../data/format.ts";
import { Permission, type AddFailure, type Invite, type Person, type Remote } from "../data/remote.ts";
import { useChat, useDialogOrder, useMessage, useServices, useUser } from "../data/services.tsx";
import { useNameOf } from "./chat-row.tsx";
import { displayLink, inviteLinks, isActiveInvite } from "./members.ts";
import { presenceText } from "./presence.tsx";
import { isOwnAccount, usePeopleSearch } from "./people-search.ts";
import { ContactsGlyph } from "./contacts-glyph.tsx";
import { ChatAvatar, CopyButton, copyText, DialogHead, Modal, Switch, useDomId } from "./parts.tsx";
import { useUi } from "./ui-context.tsx";
import { usePrivateChatFailure } from "./private-chat-failure.ts";
import { usePhotoDraft, useUploadPhoto } from "./photo-crop.tsx";

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
	/** The profile photo the viewer may see (User.photoId). */
	readonly photoId?: string | undefined;
}

export function NewChatDialog({ onClose }: CloseProps) {
	const copy = useScreensCopy();
	const ui = useUi();
	const { remote } = useServices();
	const [query, setQuery] = useState("");
	const [opening, setOpening] = useState(0);
	const { people, failed } = usePeopleSearch(query);
	const id = useDomId("nc");
	const email = query.includes("@") && !query.trim().startsWith("@");

	const privateChatFailed = usePrivateChatFailure();
	const open = (person: Person) => {
		setOpening(person.id);
		remote.createPrivate(person.id).then(
			(chatId) => {
				onClose();
				navigate(paths.chat(chatId));
			},
			(err: unknown) => {
				setOpening(0);
				privateChatFailed(err, person.id);
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
						<ChatAvatar id={person.id} name={person.name} photoOf={person.id} photoId={person.photoId} bot={person.isBot} />
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
					<button type="button" onClick={() => ui.dialog.set({ kind: "newGroup", withUserId: 0 })}>
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

/**
 * The default list of the member picker: your contacts, then the people of
 * your private chats (#new-group: "Gợi ý từ danh bạ").
 */
function useSuggestedPeople(): Candidate[] {
	const copy = useScreensCopy();
	const { remote, store } = useServices();
	const contacts = useContacts(remote);
	const order = useDialogOrder();
	return useMemo(() => {
		const people = new Map<number, Candidate>();
		for (const { person } of contacts.entries) {
			people.set(person.id, { id: person.id, name: person.name, detail: personDetail(person, copy), isBot: person.isBot, photoId: person.photoId });
		}
		for (const chatId of order) {
			const view = store.dialog(chatId);
			const peer = view?.peer;
			if (view?.chat?.type !== "private" || peer == null || peer.isSelf || people.has(peer.id)) continue;
			people.set(peer.id, { id: peer.id, name: peer.name, detail: peer.isBot ? copy.newGroup.bot : peer.username === "" ? "" : `@${peer.username}`, isBot: peer.isBot, photoId: peer.photoId });
		}
		return [...people.values()];
	}, [contacts, order, store, copy]);
}

/** "@username · Đang hoạt động", or the bot line. */
function personDetail(person: Person, copy: FullCopy): string {
	if (person.isBot) return copy.newGroup.bot;
	const presence = presenceText(person.presence, copy);
	return person.username === "" ? presence : `@${person.username} · ${presence}`;
}

interface PickerProps {
	selected: ReadonlyMap<number, Candidate>;
	onToggle: (candidate: Candidate) => void;
	exclude?: ReadonlySet<number>;
}

function PeoplePicker({ selected, onToggle, exclude }: PickerProps) {
	const copy = useScreensCopy();
	const [query, setQuery] = useState("");
	const suggested = useSuggestedPeople();
	const { people, failed } = usePeopleSearch(query);
	const searching = query.trim() !== "";
	const needle = fold(query.trim().replace(/^@/, ""));
	// Suggestions that match show at once; the server's matches join them.
	const local = suggested.filter((c) => needle === "" || fold(c.name).includes(needle) || c.detail.toLowerCase().includes(`@${needle}`));
	const remoteMatches = (people ?? []).map((p) => ({ id: p.id, name: p.name, detail: personDetail(p, copy), isBot: p.isBot, photoId: p.photoId }));
	const candidates = searching ? [...local, ...remoteMatches.filter((c) => !local.some((l) => l.id === c.id))] : local;
	// Picked people stay on the list even when the search moves on.
	const shown = [...[...selected.values()].filter((c) => !candidates.some((x) => x.id === c.id)), ...candidates].filter((c) => exclude?.has(c.id) !== true);
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
						<ChatAvatar id={candidate.id} name={candidate.name} photoOf={candidate.id} photoId={candidate.photoId} bot={candidate.isBot} />
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
					<ChatAvatar id={item.id} name={item.name} photoOf={item.id} photoId={item.photoId} size="xs" bot={item.isBot} />
					{item.name}
					<Icon name="x" />
				</button>
			))}
		</div>
	);
}

function pickedNames(selected: ReadonlyMap<number, Candidate>): ReadonlyMap<number, string> {
	return new Map([...selected].map(([userId, candidate]) => [userId, candidate.name]));
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

/** Group titles are at most 128 characters on the server. */
const TITLE_MAX = 128;

/** Without a name the group is named after its first three members (#new-group). */
export function autoGroupName(names: readonly string[]): string {
	return names.slice(0, 3).join(", ").slice(0, TITLE_MAX);
}

/** The people a server refusal is worth showing: everything except "already a member". */
function realFailures(failures: readonly AddFailure[]): AddFailure[] {
	return failures.filter((failure) => failure.reason !== "already_member");
}

/**
 * One screen (#new-group): an optional name (empty: the first three members),
 * the people picker with chips and the history switch. Opened from a profile,
 * that person is picked already and Back returns to the profile.
 */
export function NewGroupDialog({ withUserId, onClose }: CloseProps & { withUserId: number }) {
	const copy = useScreensCopy();
	const ui = useUi();
	const { remote, toasts } = useServices();
	const preset = useUser(withUserId);
	const [selected, toggle] = useSelection();
	const [presetDone, setPresetDone] = useState(withUserId === 0);
	const [name, setName] = useState("");
	const [history, setHistory] = useState(true);
	const [topics, setTopics] = useState(false);
	const [busy, setBusy] = useState(false);
	const photo = usePhotoDraft("pick-group-photo");
	const upload = useUploadPhoto();
	const id = useDomId("ng");
	if (!presetDone && preset !== undefined) {
		setPresetDone(true);
		toggle({ id: preset.id, name: preset.name, detail: preset.username === "" ? "" : `@${preset.username}`, isBot: preset.isBot, photoId: preset.photoId });
	}
	const auto = autoGroupName([...selected.values()].map((candidate) => candidate.name));

	const create = async () => {
		const title = name.trim() === "" ? auto : name.trim();
		// Nobody picked is fine (#first-run): the group starts with you and an invite link.
		if (title === "") return;
		setBusy(true);
		try {
			const ids = [...selected.keys()];
			const { chatId, failures } = await remote.createGroup(title, ids, topics);
			if (!history) await remote.setHistoryShared(chatId, false).catch(() => undefined);
			// The group exists already: a photo that fails to go up is only reported.
			if (photo.draft !== null) {
				await upload(photo.draft.blob)
					.then((photoFileId) => remote.updateChatInfo(chatId, { photoFileId }))
					.catch(() => toasts.show(copy.common.failed));
			}
			toasts.show(copy.newGroup.created(title));
			navigate(paths.chat(chatId));
			const refused = realFailures(failures);
			if (refused.length > 0) {
				const added = ids.filter((userId) => !failures.some((failure) => failure.userId === userId));
				ui.dialog.set({ kind: "addFailed", chatId, failures, addedIds: added, pickedNames: pickedNames(selected) });
			} else if (ids.length === 0) ui.dialog.set({ kind: "inviteTeam", chatId });
			else onClose();
		} catch {
			setBusy(false);
			toasts.show(copy.common.failed);
		}
	};

	const presetName = preset?.name ?? "";
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead
				id={id}
				title={withUserId === 0 ? copy.newGroup.title : copy.newGroup.titleWith(presetName)}
				{...(withUserId === 0
					? {}
					: { onBack: () => ui.dialog.set({ kind: "profile", userId: withUserId }), backLabel: copy.newGroup.backToProfile(presetName) })}
				onClose={onClose}
			/>
			<div className="dlg-body stack">
				<div className="name-row">
					<button type="button" className="photo-pick" aria-label={(name.trim() || auto) === "" ? copy.photo.choose : copy.photo.pick(name.trim() || auto)} onClick={photo.open}>
						{photo.draft !== null ? <img className="avatar-photo" src={photo.draft.url} alt="" /> : <Icon name="camera" />}
					</button>
					<div className="field">
						<label htmlFor={`${id}-name`}>
							{copy.newGroup.name} <span className="muted">{copy.newGroup.optional}</span>
						</label>
						<input
							id={`${id}-name`}
							className="input"
							maxLength={TITLE_MAX}
							value={name}
							placeholder={auto}
							aria-describedby={`${id}-hint`}
							onChange={(event) => setName(event.target.value)}
						/>
						<span className="hint" id={`${id}-hint`}>
							{copy.newGroup.nameHint}
						</span>
					</div>
				</div>
				{photo.error !== "" && (
					<span className="error-text" role="alert">
						{photo.error}
					</span>
				)}
				<PeoplePicker selected={selected} onToggle={toggle} />
				<div className="row">
					<span className="grow">
						{copy.newGroup.history}
						<small>{copy.newGroup.historyHint}</small>
					</span>
					<Switch checked={history} label={copy.newGroup.history} onChange={setHistory} />
				</div>
				<div className="row">
					<span className="grow">
						{copy.newGroup.topics}
						<small>{copy.newGroup.topicsHint}</small>
					</span>
					<Switch checked={topics} label={copy.newGroup.topics} onChange={setTopics} />
				</div>
				<p className="note">
					<Icon name="info" />
					<span>{selected.size === 0 ? copy.newGroup.aloneHint : copy.newGroup.suggestions}</span>
				</p>
			</div>
			<div className="dlg-foot">
				<button type="button" className="btn" onClick={onClose}>
					{copy.common.cancel}
				</button>
				<button
					type="button"
					className="btn btn-primary"
					aria-busy={busy}
					disabled={busy || (selected.size === 0 && name.trim() === "")}
					onClick={() => void create()}
				>
					{copy.newGroup.create(selected.size)}
				</button>
			</div>
			{photo.elements}
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
		const ids = [...selected.keys()];
		remote.addMembers(chatId, ids).then(
			(failures) => {
				const added = ids.filter((userId) => !failures.some((failure) => failure.userId === userId));
				if (realFailures(failures).length > 0) {
					ui.dialog.set({ kind: "addFailed", chatId, failures, addedIds: added, pickedNames: pickedNames(selected) });
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

export function ForwardDialog({ chatId, seq, seqs, onClose }: CloseProps & { chatId: number; seq: number; seqs: readonly number[] }) {
	const copy = useScreensCopy();
	const { remote, source, store, toasts } = useServices();
	const order = useDialogOrder();
	const message = useMessage(chatId, seq);
	const nameOf = useNameOf(message == null ? [] : namedUserIds(message));
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
			await remote.forward(chatId, seqs, target);
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

	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={copy.forward.title} onClose={onClose} />
			<div className="dlg-body stack">
				{message != null && (
					<div className="quote">
						<b>{nameOf(message.fromId)}</b>
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

/** Where the way round a refusal stands for one person in the add-members result. */
type RowState = "idle" | "sending" | "sent" | "refused" | "done";

interface AddFailedProps extends CloseProps {
	chatId: number;
	failures: readonly AddFailure[];
	addedIds: readonly number[];
	pickedNames: ReadonlyMap<number, string>;
}

/**
 * The add-members result (#add-members): who was added or already there,
 * and for each person the server refused, the reason it gave and what still
 * works. Privacy refusals (and people who blocked you, shown the same way so
 * a block stays private): an invite link sent in a private chat, or a private
 * chat; when their "message me" setting refuses you too, the link is copied
 * for you to send another way. People you blocked: unblock. Banned: admins
 * unban and add. Unknown accounts and a full chat: the reason only.
 */
const inviteLinkRequests = new Map<number, Promise<string>>();

/**
 * The chat's active invite link: a cached or server-side one, else a new one
 * (no expiry, no use limit). Concurrent calls for a chat share one request,
 * so a dialog effect run twice never creates two links.
 */
function activeInviteLink(remote: Remote, chatId: number): Promise<string> {
	const pending = inviteLinkRequests.get(chatId);
	if (pending !== undefined) return pending;
	const request = (async () => {
		const isActive = (invite: Invite) => isActiveInvite(invite, Date.now());
		const cached = inviteLinks.list(chatId).find(isActive);
		if (cached !== undefined) return cached.link;
		const stored = (await remote.inviteLinks(chatId)).find(isActive);
		const invite = stored ?? (await remote.exportInvite(chatId, 0, 0));
		inviteLinks.add(chatId, invite);
		return invite.link;
	})().finally(() => inviteLinkRequests.delete(chatId));
	inviteLinkRequests.set(chatId, request);
	return request;
}

/**
 * Right after creating a group with nobody in it (#first-run-invite): the
 * group's invite link to copy or share wherever the team already talks.
 */
export function InviteTeamDialog({ chatId, onClose }: CloseProps & { chatId: number }) {
	const copy = useScreensCopy();
	const { remote, toasts } = useServices();
	const chat = useChat(chatId);
	const [link, setLink] = useState<string | null>(null);
	const id = useDomId("invite-team");
	const title = chat?.title ?? "";
	const failed = copy.common.failed;

	useEffect(() => {
		let active = true;
		activeInviteLink(remote, chatId).then(
			(found) => {
				if (active) setLink(found);
			},
			() => {
				if (active) toasts.show(failed);
			},
		);
		return () => {
			active = false;
		};
	}, [remote, chatId, toasts, failed]);

	const copyLink = () => {
		if (link === null) return;
		void copyText(link).then((ok) => toasts.show(ok ? copy.inviteTeam.copied : failed));
	};
	const share = () => {
		if (link === null) return;
		navigator.share({ title: copy.inviteTeam.shareText(title), url: link }).catch(() => undefined);
	};
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={copy.inviteTeam.title(title)} onClose={onClose} />
			<div className="dlg-body stack">
				<div className="row">
					<Icon name="link" />
					<span className="grow">
						{link === null ? <span className="spin" aria-hidden="true" /> : <MiddleTruncate className="value" text={displayLink(link)} />}
						<small>{copy.inviteTeam.manage}</small>
					</span>
					{link !== null && <CopyButton text={link} label={copy.info.copyInvite} copiedLabel={copy.info.copiedInvite} />}
				</div>
				<p className="note">
					<Icon name="info" />
					<span>{copy.inviteTeam.note}</span>
				</p>
			</div>
			<div className="dlg-foot">
				{typeof navigator.share === "function" && (
					<button type="button" className="btn" disabled={link === null} onClick={share}>
						<Icon name="forward" />
						{copy.inviteTeam.share}
					</button>
				)}
				<button type="button" className="btn btn-primary" disabled={link === null} onClick={copyLink}>
					{copy.inviteTeam.copy}
				</button>
			</div>
		</Modal>
	);
}

export function AddFailedDialog({ chatId, failures, addedIds, pickedNames, onClose }: AddFailedProps) {
	const copy = useScreensCopy();
	const { remote, source, toasts } = useServices();
	const chat = useChat(chatId);
	const [people, setPeople] = useState<ReadonlyMap<number, Person>>(new Map());
	const [states, setStates] = useState<ReadonlyMap<number, RowState>>(new Map());
	const id = useDomId("failed");
	const t = copy.addFailed;
	const title = chat?.title ?? "";
	const admin = chat?.myRole === "admin" || chat?.myRole === "owner";
	const channel = chat?.type === "channel";
	const refused = realFailures(failures);
	const already = failures.filter((failure) => failure.reason === "already_member").map((failure) => failure.userId);

	useEffect(() => {
		let active = true;
		const ids = [...new Set([...failures.map((failure) => failure.userId), ...addedIds])];
		remote.people(ids).then(
			(found) => {
				if (active) setPeople(new Map(found.map((person) => [person.id, person])));
			},
			() => undefined,
		);
		return () => {
			active = false;
		};
	}, [remote, failures, addedIds]);

	const setState = (userId: number, state: RowState) => setStates((current) => new Map(current).set(userId, state));
	// Someone who refused you is often not visible through GetUsers yet; the
	// picker already showed you their name.
	const nameOf = (userId: number) => people.get(userId)?.name ?? pickedNames.get(userId) ?? copy.message.unknownUser;
	const inviteLink = (): Promise<string> => activeInviteLink(remote, chatId);
	const sendInvite = async (userId: number): Promise<void> => {
		setState(userId, "sending");
		try {
			const link = await inviteLink();
			const privateChat = await remote.createPrivate(userId);
			await source.sendText(privateChat, link);
			setState(userId, "sent");
			toasts.show(t.inviteSentToast(nameOf(userId)));
		} catch (err) {
			// Their "message me" privacy refuses a private chat with you.
			const refusedChat = ConnectError.from(err).code === Code.PermissionDenied;
			setState(userId, refusedChat ? "refused" : "idle");
			if (!refusedChat) toasts.show(copy.common.failed);
		}
	};
	const copyLink = async () => {
		const ok = await inviteLink().then(copyText, () => false);
		toasts.show(ok ? t.copied(title) : copy.common.failed);
	};
	const privateChatFailed = usePrivateChatFailure();
	const message = (userId: number) => {
		remote.createPrivate(userId).then(
			(privateChat) => {
				onClose();
				navigate(paths.chat(privateChat));
			},
			(err: unknown) => privateChatFailed(err, userId),
		);
	};
	const unblock = (userId: number) => {
		setState(userId, "sending");
		remote.unblock(userId).then(
			() => {
				setState(userId, "done");
				toasts.show(t.unblocked(nameOf(userId)));
			},
			() => {
				setState(userId, "idle");
				toasts.show(copy.common.failed);
			},
		);
	};
	const unbanAndAdd = (userId: number) => {
		setState(userId, "sending");
		remote
			.unbanMember(chatId, userId)
			.then(() => remote.addMembers(chatId, [userId]))
			.then(
				(again) => {
					const ok = !again.some((failure) => failure.userId === userId && failure.reason !== "already_member");
					setState(userId, ok ? "done" : "idle");
					toasts.show(ok ? t.unbannedAdded(nameOf(userId), channel) : copy.common.failed);
				},
				() => {
					setState(userId, "idle");
					toasts.show(copy.common.failed);
				},
			);
	};

	/** People you blocked are told so; everyone else refusing is a privacy refusal. */
	const kindOf = (failure: AddFailure): "privacy" | "youBlocked" | "banned" | "not_found" | "too_many" => {
		if (people.get(failure.userId)?.isBlocked === true) return "youBlocked";
		if (failure.reason === "privacy" || failure.reason === "blocked" || failure.reason === "already_member") return "privacy";
		return failure.reason;
	};
	const reasonText = (failure: AddFailure): string => {
		switch (kindOf(failure)) {
			case "privacy":
				return t.reasonPrivacy(nameOf(failure.userId), channel);
			case "youBlocked":
				return t.reasonYouBlocked;
			case "banned":
				return t.reasonBanned(channel);
			case "not_found":
				return t.reasonNotFound;
			case "too_many":
				return t.reasonTooMany(channel);
		}
	};
	const pending = refused.filter((failure) => kindOf(failure) === "privacy" && (states.get(failure.userId) ?? "idle") === "idle");
	const busy = [...states.values()].includes("sending");
	const sendAll = async () => {
		for (const failure of pending) await sendInvite(failure.userId);
	};

	const addedNames = addedIds.map(nameOf);
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={t.title(refused.length)} onClose={onClose} />
			<div className="dlg-body stack">
				{(addedIds.length > 0 || already.length > 0) && (
					<p className="note ok">
						<Icon name="check" />
						<span>
							{addedIds.length > 0 && t.added(joinNames(addedNames, copy.system.and), title)}
							{addedIds.length > 0 && already.length > 0 && " "}
							{already.length > 0 && t.already(joinNames(already.map(nameOf), copy.system.and), channel)}
						</span>
					</p>
				)}
				<ul className="fail-list">
					{refused.map((failure) => {
						const userId = failure.userId;
						const person = people.get(userId);
						const state = states.get(userId) ?? "idle";
						const kind = kindOf(failure);
						const whyId = `${id}-why-${userId}`;
						return (
							<li key={userId}>
								<div className="row">
									<ChatAvatar id={userId} name={person?.name ?? pickedNames.get(userId) ?? "?"} bot={person?.isBot === true} />
									<span className="grow">
										{nameOf(userId)}
										<small>{reasonText(failure)}</small>
									</span>
								</div>
								{kind === "privacy" && (
									<div className="pick-actions" role="group" aria-label={t.otherWays(nameOf(userId))} aria-describedby={state === "refused" ? whyId : undefined}>
										<button
											type="button"
											className="btn btn-compact"
											aria-busy={state === "sending"}
											disabled={state !== "idle" || busy}
											onClick={() => void sendInvite(userId)}
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
											<button type="button" className="btn btn-compact" disabled={busy} onClick={() => message(userId)}>
												<Icon name="message" />
												{t.message}
											</button>
										)}
									</div>
								)}
								{kind === "youBlocked" && state !== "done" && (
									<div className="pick-actions" role="group" aria-label={t.actionsFor(nameOf(userId))}>
										<button type="button" className="btn btn-compact" aria-busy={state === "sending"} disabled={busy} onClick={() => unblock(userId)}>
											<Icon name="ban" />
											{t.unblock}
										</button>
									</div>
								)}
								{kind === "banned" && admin && state !== "done" && (
									<div className="pick-actions" role="group" aria-label={t.actionsFor(nameOf(userId))}>
										<button type="button" className="btn btn-compact" aria-busy={state === "sending"} disabled={busy} onClick={() => unbanAndAdd(userId)}>
											<Icon name="user-plus" />
											{t.unbanAdd}
										</button>
									</div>
								)}
								{state === "sent" && (
									<p className="why">
										<Icon name="check" />
										{t.inviteSent(nameOf(userId))}
									</p>
								)}
								{state === "refused" && (
									<p className="why" id={whyId}>
										<Icon name="lock" />
										{t.cantSend(nameOf(userId))}
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
