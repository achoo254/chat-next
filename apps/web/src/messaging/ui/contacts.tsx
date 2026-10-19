// Contacts (mockups/chat.html#contacts): the list you curate yourself, opened
// from "Danh bạ" in the folder rail (narrow screens: the list header), A–Z
// with a letter over each group. Rows show the @username and presence as
// each person's privacy allows; the search matches names without accents. A
// row opens the profile card on the right (full screen on narrow screens,
// with a way back): message, new group with them, block, the date you added
// them and the groups you share.
import { fold } from "@app/core";
import { useState, type ReactNode } from "react";
import { useLoader } from "../../components/delayed-loader.tsx";
import { Icon } from "../../components/screen-icons.tsx";
import { MiddleTruncate } from "../../components/middle-truncate.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { Link, navigate, paths } from "../../router.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { contactsOf, useContacts } from "../data/contacts.ts";
import type { Contact } from "../data/remote.ts";
import { useServices, useUser } from "../data/services.tsx";
import { useCommonChats } from "./common-chats.tsx";
import { ContactRow } from "./contact-row.tsx";
import { ChatAvatar, CopyButton, useDomId } from "./parts.tsx";
import { presenceText } from "./presence.tsx";
import { useUi } from "./ui-context.tsx";
import { usePrivateChatFailure } from "./private-chat-failure.ts";

export function ContactsView({ userId }: { userId: number }) {
	const copy = useScreensCopy();
	const { locale } = useI18n();
	const { remote } = useServices();
	const ui = useUi();
	const contacts = useContacts(remote);
	// One loader with the view's code (LoaderBoundary in chat-screen.tsx), which also starts the load.
	const loader = useLoader(contacts.status === "idle" || contacts.status === "loading", copy.common.loading);
	const [query, setQuery] = useState("");
	const t = copy.contacts;
	const needle = fold(query.trim().replace(/^@/, ""));
	const shown = contacts.entries.filter(({ person }) => needle === "" || fold(person.name).includes(needle) || person.username.toLowerCase().startsWith(needle));
	const addButton = (primary: boolean) => (
		<button type="button" className={primary ? "btn btn-primary" : "btn"} onClick={() => ui.dialog.set({ kind: "addContact" })}>
			<Icon name="user-plus" />
			{t.add}
		</button>
	);

	let body: ReactNode;
	if (contacts.status === "error") {
		body = (
			<div className="banner error" role="alert">
				<Icon name="alert" small />
				<span className="grow">{copy.common.loadFailed}</span>
				<button type="button" className="btn btn-sm" onClick={() => void contactsOf(remote).load(true)}>
					{copy.common.retry}
				</button>
			</div>
		);
	} else if (loader !== null || contacts.status !== "ready") {
		body = loader;
	} else if (contacts.entries.length === 0) {
		body = (
			<div className="empty">
				<Icon name="users" />
				<strong>{t.emptyTitle}</strong>
				<span>{t.emptyBody}</span>
				{addButton(true)}
			</div>
		);
	} else if (shown.length === 0) {
		body = (
			<div className="empty">
				<Icon name="search" />
				<strong>{t.noMatchTitle}</strong>
				<span>{t.noMatchBody}</span>
				{addButton(false)}
			</div>
		);
	} else {
		body = (
			<ul className="chats contact-list" aria-label={t.title}>
				{shown.map(({ person }, index) => {
					const online = person.presence.kind === "online";
					const letter = initialLetter(person.name);
					const previous = shown[index - 1];
					const head = previous === undefined || initialLetter(previous.person.name) !== letter;
					return (
						<li key={person.id}>
							{head && (
								<span className="az-head" aria-hidden="true">
									{letter}
								</span>
							)}
							<Link to={paths.contacts(person.id)} className="chat-row contact-row" current={person.id === userId}>
								<ChatAvatar id={person.id} name={person.name} photoOf={person.id} photoId={person.photoId} bot={person.isBot} online={online} />
								<span className="tx">
									<span className="name">
										<span className="title-text">{person.name}</span>
									</span>
									<span className="preview">
										{person.username !== "" && `@${person.username} · `}
										<span className={online ? "on" : undefined}>{presenceText(person.presence, copy, locale)}</span>
									</span>
								</span>
							</Link>
						</li>
					);
				})}
			</ul>
		);
	}

	return (
		<>
			<section className="list" aria-label={t.title}>
				<div className="list-head">
					<Link to={paths.home} className="icon-btn narrow-only" aria-label={copy.convo.backToList}>
						<Icon name="back" />
					</Link>
					<label className="search-field">
						<Icon name="search" small />
						<span className="sr-only">{t.search}</span>
						<input type="search" placeholder={t.search} autoComplete="off" value={query} onChange={(event) => setQuery(event.target.value)} />
					</label>
					<button type="button" className="icon-btn" aria-label={t.add} onClick={() => ui.dialog.set({ kind: "addContact" })}>
						<Icon name="user-plus" />
					</button>
				</div>
				{contacts.status === "ready" && contacts.entries.length > 0 && (
					<div className="list-sub">
						<span>{t.count(shown.length)}</span>
						<span>{t.byName}</span>
					</div>
				)}
				{body}
			</section>
			<section className="convo contact-main" aria-label={t.title}>
				{userId === 0 ? (
					<div className="empty">
						<Icon name="user" />
						<strong>{t.pickTitle}</strong>
						<span>{t.pickBody}</span>
					</div>
				) : (
					<ContactCard key={userId} userId={userId} listed={contacts.entries.find((entry) => entry.person.id === userId)} />
				)}
			</section>
		</>
	);
}

/** The letter a name is listed under: Vietnamese base letter (Đ stays Đ), "#" for anything else. */
export function initialLetter(name: string): string {
	const first = name.trim().charAt(0).toLocaleUpperCase("vi");
	const base = first.normalize("NFD").replace(/\p{Mn}/gu, "");
	return /\p{L}/u.test(base) ? base : "#";
}

function ContactCard({ userId, listed }: { userId: number; listed: Contact | undefined }) {
	const copy = useScreensCopy();
	const { locale } = useI18n();
	const { remote, toasts } = useServices();
	const ui = useUi();
	const user = useUser(userId);
	const common = useCommonChats(userId);
	const [blocked, setBlocked] = useState<boolean | null>(null);
	const [opening, setOpening] = useState(false);
	const id = useDomId("contact");
	const person = listed?.person;
	const name = person?.name ?? user?.name ?? copy.message.unknownUser;
	const username = person?.username ?? user?.username ?? "";
	const isBot = person?.isBot ?? user?.isBot ?? false;
	const isBlocked = blocked ?? person?.isBlocked ?? user?.isBlocked ?? false;
	const online = person?.presence.kind === "online";

	const privateChatFailed = usePrivateChatFailure();
	const message = () => {
		setOpening(true);
		remote.createPrivate(userId).then(
			(chatId) => navigate(paths.chat(chatId)),
			(err: unknown) => {
				setOpening(false);
				privateChatFailed(err, userId);
			},
		);
	};
	const toggleBlock = () => {
		const next = !isBlocked;
		(next ? remote.block(userId) : remote.unblock(userId)).then(
			() => {
				setBlocked(next);
				toasts.show(next ? copy.info.blocked(name) : copy.info.unblocked(name));
			},
			() => toasts.show(copy.common.failed),
		);
	};

	return (
		<div className="contact-card" role="group" aria-labelledby={id}>
			<Link to={paths.contacts()} className="icon-btn narrow-only contact-back" aria-label={copy.contacts.backToList}>
				<Icon name="back" />
			</Link>
			<div className="info-hero">
				<ChatAvatar id={userId} name={name} size="lg" bot={isBot} online={online} />
				<h2 id={id}>{name}</h2>
				{person !== undefined && <span className={online ? "muted on" : "muted"}>{presenceText(person.presence, copy, locale)}</span>}
			</div>
			<div className="profile-actions">
				<button type="button" className="btn btn-primary" aria-busy={opening} disabled={opening} onClick={message}>
					<Icon name="message" />
					{copy.info.message}
				</button>
				{!isBot && (
					<button type="button" className="btn" onClick={() => ui.dialog.set({ kind: "newGroup", withUserId: userId })}>
						<Icon name="users" />
						{copy.info.createGroup}
					</button>
				)}
				<button type="button" className="btn danger-text" onClick={toggleBlock}>
					<Icon name="ban" />
					{isBlocked ? copy.info.unblock : copy.info.block}
				</button>
			</div>
			<div className="info-sec">
				<ContactRow userId={userId} name={name} />
			</div>
			<div className="info-sec">
				{username !== "" && (
					<div className="row">
						<Icon name="user" />
						<span className="grow">
							<MiddleTruncate text={`@${username}`} tail={4} />
							<small>{copy.info.username}</small>
						</span>
						<CopyButton text={`@${username}`} label={copy.info.copyUsername} copiedLabel={copy.info.copiedUsername(username)} />
					</div>
				)}
				{common !== null && (
					<button type="button" className="row link-row" onClick={() => ui.dialog.set({ kind: "profile", userId })}>
						<Icon name="users" />
						<span className="grow">{common.count === 0 ? copy.profile.noCommonGroups : copy.profile.commonGroups(common.count)}</span>
						<Icon name="chevron-right" small />
					</button>
				)}
				<button type="button" className="row link-row" onClick={() => ui.dialog.set({ kind: "profile", userId })}>
					<Icon name="info" />
					<span className="grow">{copy.contacts.fullProfile}</span>
					<Icon name="chevron-right" small />
				</button>
			</div>
		</div>
	);
}
