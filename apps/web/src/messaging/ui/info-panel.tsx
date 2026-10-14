// Right column (mockups/chat.html#info-panels, #topics): group or channel,
// the other person of a 1-1 chat, or the open topic. Opened with the "i"
// button, closed with X.
import { useState } from "react";
import type { Chat, User } from "@app/core";
import { Icon } from "../../components/icon.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { Link, navigate, paths } from "../../router.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { dialogTitle, shortDate, userName } from "../data/format.ts";
import type { Topic } from "../data/pending-backend.ts";
import { Permission } from "../data/remote.ts";
import { useServices, useUser } from "../data/services.tsx";
import { hiddenPins, usePinHidden } from "./conversation.tsx";
import { displayLink, inviteLinks, isActiveInvite, useInviteLinks, useMembers } from "./members.ts";
import { ChatAvatar, CopyButton, Switch } from "./parts.tsx";
import { usePresence, usePresenceText } from "./presence.tsx";
import { TopicIco } from "./topic-ico.tsx";
import { useUi } from "./ui-context.tsx";

const MEMBERS_SHOWN = 20;

function InfoHead({ title }: { title: string }) {
	const copy = useCopy();
	const ui = useUi();
	return (
		<div className="info-head">
			<span>{title}</span>
			<button type="button" className="icon-btn" aria-label={copy.info.close} onClick={() => ui.toggleInfo(false)}>
				<Icon name="x" />
			</button>
		</div>
	);
}

function MuteButton({ chatId }: { chatId: number }) {
	const copy = useCopy();
	const { backend, toasts } = useServices();
	const supported = backend.features.has("mute");
	const muted = backend.isMuted(chatId);
	return (
		<button
			type="button"
			className="btn"
			aria-pressed={muted}
			disabled={!supported}
			title={supported ? undefined : copy.common.soon}
			onClick={() => backend.setMuted(chatId, !muted).catch(() => toasts.show(copy.common.failed))}
		>
			<Icon name={muted ? "bell" : "bell-off"} />
			<span>{muted ? copy.convo.unmute : copy.convo.mute}</span>
		</button>
	);
}

function PinnedBarRow({ chat }: { chat: Chat }) {
	const copy = useCopy();
	const hidden = usePinHidden(chat.id);
	if (chat.pinnedSeq === 0 || hidden !== chat.pinnedSeq) return null;
	return (
		<div className="row">
			<Icon name="pin" />
			<span className="grow">{copy.info.pinnedBar}</span>
			<Switch checked={false} label={copy.pinned.show} onChange={() => hiddenPins.set(chat.id, 0)} />
		</div>
	);
}

function InviteRow({ chat }: { chat: Chat }) {
	const copy = useCopy();
	const { locale } = useI18n();
	const { remote, toasts } = useServices();
	const invites = useInviteLinks(chat.id);
	const [busy, setBusy] = useState(false);
	const [now] = useState(Date.now);
	const invite = invites.find((item) => isActiveInvite(item, now));
	if (invite !== undefined) {
		return (
			<div className="row">
				<Icon name="link" />
				<span className="grow">
					<span className="link-mono">{displayLink(invite.link)}</span>
					<small>{invite.expiresAt === 0 ? copy.info.inviteNoExpiry : copy.info.inviteExpires(shortDate(invite.expiresAt, locale))}</small>
				</span>
				<CopyButton text={invite.link} label={copy.info.copyInvite} copiedLabel={copy.info.copiedInvite} />
			</div>
		);
	}
	return (
		<div className="row">
			<Icon name="link" />
			<span className="grow">{copy.info.inviteLink}</span>
			<button
				type="button"
				className="btn btn-sm"
				aria-busy={busy}
				disabled={busy}
				onClick={() => {
					setBusy(true);
					remote
						.exportInvite(chat.id, 0, 0)
						.then(
							(created) => inviteLinks.add(chat.id, created),
							() => toasts.show(copy.common.failed),
						)
						.finally(() => setBusy(false));
				}}
			>
				{copy.info.createInvite}
			</button>
		</div>
	);
}

function GroupMembers({ chat }: { chat: Chat }) {
	const copy = useCopy();
	const { store } = useServices();
	const ui = useUi();
	const [searching, setSearching] = useState(false);
	const [query, setQuery] = useState("");
	const [expanded, setExpanded] = useState(false);
	const { members, status, hasMore, more } = useMembers(chat.id, query.trim());
	const admin = chat.myRole === "admin" || chat.myRole === "owner";
	const canAdd = admin || (chat.myPermissions & Permission.addMembers) !== 0;
	const shown = expanded ? members : members.slice(0, MEMBERS_SHOWN);
	return (
		<div className="info-sec">
			<div className="sec-head">
				<h3>{copy.info.membersHead(chat.memberCount)}</h3>
				<button type="button" className="icon-btn" aria-label={copy.info.searchMembers} aria-pressed={searching} onClick={() => setSearching((on) => !on)}>
					<Icon name="search" small />
				</button>
			</div>
			{searching && (
				<label className="search-field member-search">
					<Icon name="search" small />
					<span className="sr-only">{copy.info.searchMembers}</span>
					<input type="search" value={query} autoComplete="off" onChange={(event) => setQuery(event.target.value)} />
				</label>
			)}
			{canAdd && (
				<button type="button" className="btn btn-block" onClick={() => ui.dialog.set({ kind: "addMembers", chatId: chat.id })}>
					<Icon name="user-plus" />
					{copy.info.addMembers}
				</button>
			)}
			{status === "loading" && <p className="note">{copy.common.loading}</p>}
			{status === "error" && <p className="note">{copy.common.loadFailed}</p>}
			{shown.map((member) => {
				const self = member.person.id === store.selfId;
				return (
					<MemberLine
						key={member.person.id}
						userId={member.person.id}
						avatarName={member.person.name}
						name={self ? copy.common.you : member.person.name}
						isBot={member.person.isBot}
						role={member.role}
						presence={member.person.presence.kind === "online" || self}
					/>
				);
			})}
			{(hasMore || (!expanded && members.length > MEMBERS_SHOWN)) && (
				<button
					type="button"
					className="see-all"
					onClick={() => {
						setExpanded(true);
						if (hasMore) more();
					}}
				>
					{copy.info.seeAll(chat.memberCount)}
				</button>
			)}
		</div>
	);
}

interface MemberLineProps {
	userId: number;
	/** The person's own name, for the initials ("Bạn" is shown as the label). */
	avatarName: string;
	name: string;
	isBot: boolean;
	role: string;
	presence: boolean;
}

function MemberLine({ userId, avatarName, name, isBot, role, presence }: MemberLineProps) {
	const copy = useCopy();
	const ui = useUi();
	const { store } = useServices();
	const known = usePresence(isBot || userId === store.selfId ? 0 : userId);
	const text = usePresenceText(known, copy);
	const online = presence || known?.kind === "online";
	const label = isBot ? copy.info.bot : userId === store.selfId ? copy.info.online : text;
	return (
		<button type="button" className="row member-row" onClick={() => ui.dialog.set({ kind: "profile", userId })}>
			<ChatAvatar id={userId} name={avatarName} size="sm" bot={isBot} online={online && !isBot} />
			<span className="grow">
				{name}
				<small className={online && !isBot ? "on" : undefined}>{label}</small>
			</span>
			{role === "owner" && <span className="tag">{copy.info.owner}</span>}
			{role === "admin" && <span className="tag grey">{copy.info.admin}</span>}
		</button>
	);
}

function GroupInfo({ chat }: { chat: Chat }) {
	const copy = useCopy();
	const ui = useUi();
	const channel = chat.type === "channel";
	const admin = chat.myRole === "admin" || chat.myRole === "owner";
	const canInvite = admin || (!channel && (chat.myPermissions & Permission.addMembers) !== 0);
	return (
		<aside className="info" aria-label={channel ? copy.info.channelTitle : copy.info.groupTitle}>
			<InfoHead title={channel ? copy.info.channelTitle : copy.info.groupTitle} />
			<div className="info-hero">
				<ChatAvatar id={chat.id} name={chat.title} size="lg" />
				<h2>{chat.title}</h2>
				<span className="muted">{channel ? copy.info.channel(chat.memberCount) : copy.info.group(chat.memberCount)}</span>
			</div>
			<div className="profile-actions">
				<MuteButton chatId={chat.id} />
				{admin && (
					<Link to={paths.chatAdmin(chat.id)} className="btn">
						<Icon name="settings" />
						{copy.info.manage}
					</Link>
				)}
				{!chat.left && (
					<button type="button" className="btn danger-text" onClick={() => ui.dialog.set({ kind: "leave", chatId: chat.id })}>
						<Icon name="logout" />
						{channel ? copy.info.leaveChannel : copy.info.leaveGroup}
					</button>
				)}
			</div>
			<div className="info-sec">
				{chat.about !== "" && (
					<div className="row">
						<Icon name="info" />
						<span className="grow">
							{chat.about}
							<small>{copy.info.description}</small>
						</span>
					</div>
				)}
				{canInvite && <InviteRow chat={chat} />}
				<PinnedBarRow chat={chat} />
			</div>
			{(!channel || admin) && <GroupMembers chat={chat} />}
		</aside>
	);
}

function UserInfo({ chat, peer }: { chat: Chat; peer: User | undefined }) {
	const copy = useCopy();
	const { remote, backend, toasts } = useServices();
	const ui = useUi();
	const presence = usePresence(peer?.isBot === true ? 0 : chat.peerUserId);
	const presenceLabel = usePresenceText(presence, copy);
	const [blocked, setBlocked] = useState<boolean | null>(null);
	const isBlocked = blocked ?? peer?.isBlocked ?? false;
	const name = peer?.name ?? dialogTitle({ chat, peer: null }, copy);
	const toggleBlock = () => {
		const next = !isBlocked;
		(next ? remote.block(chat.peerUserId) : remote.unblock(chat.peerUserId)).then(
			() => {
				setBlocked(next);
				toasts.show(next ? copy.info.blocked(name) : copy.info.unblocked(name));
			},
			() => toasts.show(copy.common.failed),
		);
	};
	return (
		<aside className="info" aria-label={copy.info.userTitle}>
			<InfoHead title={copy.info.userTitle} />
			<div className="info-hero">
				<ChatAvatar id={chat.id} name={name} size="lg" bot={peer?.isBot === true} />
				<h2>{name}</h2>
				<span className="muted">{peer?.isBot === true ? copy.info.bot : presenceLabel}</span>
			</div>
			<div className="profile-actions">
				<button
					type="button"
					className="btn btn-primary"
					onClick={() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus()}
				>
					<Icon name="message" />
					{copy.info.message}
				</button>
				<MuteButton chatId={chat.id} />
				<button type="button" className="btn danger-text" onClick={toggleBlock}>
					<Icon name="ban" />
					{isBlocked ? copy.info.unblock : copy.info.block}
				</button>
			</div>
			<div className="info-sec">
				{peer !== undefined && peer.username !== "" && (
					<div className="row">
						<Icon name="user" />
						<span className="grow">
							@{peer.username}
							<small>{copy.info.username}</small>
						</span>
						<CopyButton text={`@${peer.username}`} label={copy.info.copyUsername} copiedLabel={copy.info.copiedUsername(peer.username)} />
					</div>
				)}
				{peer !== undefined && peer.bio !== "" && (
					<div className="row">
						<Icon name="info" />
						<span className="grow">
							{peer.bio}
							<small>{copy.info.bio}</small>
						</span>
					</div>
				)}
				<PinnedBarRow chat={chat} />
			</div>
			{backend.features.has("report") && (
				<div className="info-sec">
					<button
						type="button"
						className="row link-row"
						onClick={() => ui.dialog.set({ kind: "report", target: { kind: "user", userId: chat.peerUserId }, name, blockUserId: chat.peerUserId })}
					>
						<Icon name="flag" />
						<span className="grow">{copy.info.report}</span>
					</button>
				</div>
			)}
		</aside>
	);
}

function TopicInfo({ chat, topic, groupTitle }: { chat: Chat; topic: Topic; groupTitle: string }) {
	const copy = useCopy();
	const { locale } = useI18n();
	const { store } = useServices();
	const creator = useUser(topic.createdBy === store.selfId ? 0 : topic.createdBy);
	const admin = chat.myRole === "admin" || chat.myRole === "owner";
	return (
		<aside className="info" aria-label={copy.info.topicTitle}>
			<InfoHead title={copy.info.topicTitle} />
			<div className="info-hero">
				<TopicIco topic={topic} size="lg" />
				<h2>{topic.title}</h2>
				<span className="muted">
					{copy.info.topicIn}{" "}
					<Link to={paths.chat(chat.id)} className="link">
						{groupTitle}
					</Link>
				</span>
			</div>
			<div className="profile-actions">
				<MuteButton chatId={chat.id} />
				<button type="button" className="btn" disabled title={copy.common.soon}>
					<Icon name="search" />
					{copy.info.search}
				</button>
				{admin && (
					<button type="button" className="btn" onClick={() => navigate(paths.chatAdmin(chat.id))}>
						<Icon name="settings" />
						{copy.info.manage}
					</button>
				)}
			</div>
			{topic.link !== "" && (
				<div className="info-sec">
					<h3>{copy.info.topicLink}</h3>
					<div className="copy-field">
						<span className="link-mono">{displayLink(topic.link)}</span>
						<CopyButton text={topic.link} label={copy.info.copyTopicLink} copiedLabel={copy.info.copiedTopicLink} />
					</div>
					<p className="note">
						<Icon name="lock" />
						<span>{copy.info.topicLinkNote(groupTitle)}</span>
					</p>
				</div>
			)}
			<div className="info-sec">
				<div className="row">
					<Icon name="user" />
					<span className="grow">
						{copy.info.topicCreated(userName(creator, store.selfId, copy, topic.createdBy), shortDate(topic.createdAt, locale))}
						<small>{copy.info.topicCreator}</small>
					</span>
				</div>
			</div>
		</aside>
	);
}

interface InfoPanelProps {
	chat: Chat;
	peer: User | undefined;
	topic: Topic | null;
	title: string;
}

export function InfoPanel({ chat, peer, topic, title }: InfoPanelProps) {
	if (topic !== null) return <TopicInfo chat={chat} topic={topic} groupTitle={title} />;
	if (chat.type === "group" || chat.type === "channel") return <GroupInfo chat={chat} />;
	return <UserInfo chat={chat} peer={peer} />;
}
