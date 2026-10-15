// "Quản lý nhóm" / "Quản lý kênh" (mockups/chat.html#chat-admin): member
// permissions (a bitmask), history for new members, turning topics on, the leader and deputies
// (channels: owner and admins), the member and banned lists, invite links,
// leaving and, for the owner, deleting the chat. Channels name their people
// subscribers and skip the member permissions and history cards. "Tích hợp"
// leads to the incoming webhooks (mockups/integrations.html#hooks-list).
import { useEffect, useState } from "react";
import type { Chat } from "@app/core";
import { useLoader } from "../../components/delayed-loader.tsx";
import { Icon, type IconName } from "../../components/icon.tsx";
import { MiddleTruncate } from "../../components/middle-truncate.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { Link, paths } from "../../router.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { shortDate, userName } from "../data/format.ts";
import { Permission, type Member } from "../data/remote.ts";
import { useChat, useServices, useUser } from "../data/services.tsx";
import { displayLink, inviteLinks, isActiveInvite, useInviteLinks, useMembers } from "./members.ts";
import { ChatAvatar, Choice, CopyButton, Switch, useDomId } from "./parts.tsx";
import { useUi } from "./ui-context.tsx";

type Expiry = "hour" | "day" | "week" | "never";
const EXPIRY_SECONDS: Record<Expiry, number> = { hour: 3600, day: 86_400, week: 604_800, never: 0 };

const PERMISSIONS: readonly { bit: number; icon: IconName; key: "sendMessages" | "sendMedia" | "addMembers" | "pinMessages" | "changeInfo" }[] = [
	{ bit: Permission.sendMessages, icon: "message", key: "sendMessages" },
	{ bit: Permission.sendMedia, icon: "file", key: "sendMedia" },
	{ bit: Permission.addMembers, icon: "user-plus", key: "addMembers" },
	{ bit: Permission.pinMessages, icon: "pin", key: "pinMessages" },
	{ bit: Permission.changeInfo, icon: "edit", key: "changeInfo" },
];

function PermissionsCard({ chat }: { chat: Chat }) {
	const copy = useScreensCopy();
	const { remote, toasts } = useServices();
	const [mask, setMask] = useState<number | null>(null);
	const current = mask ?? chat.defaultPermissions;
	const id = useDomId("perm");
	const toggle = (bit: number) => {
		const next = current ^ bit;
		setMask(next);
		remote.setDefaultPermissions(chat.id, next).then(
			() => toasts.show(copy.admin.saved),
			() => {
				setMask(null);
				toasts.show(copy.common.failed);
			},
		);
	};
	return (
		<section className="card" aria-labelledby={id}>
			<h3 id={id}>{copy.admin.permissions}</h3>
			<p>{copy.admin.permissionsNote}</p>
			{PERMISSIONS.map((permission) => (
				<div className="row" key={permission.key}>
					<Icon name={permission.icon} />
					<span className="grow">{copy.admin[permission.key]}</span>
					<Switch checked={(current & permission.bit) !== 0} label={copy.admin[permission.key]} onChange={() => toggle(permission.bit)} />
				</div>
			))}
		</section>
	);
}

function HistoryCard({ chat }: { chat: Chat }) {
	const copy = useScreensCopy();
	const { remote, toasts } = useServices();
	const [shared, setShared] = useState<boolean | null>(null);
	const value = shared ?? chat.historyShared;
	const id = useDomId("hist");
	const toggle = (next: boolean) => {
		setShared(next);
		remote.setHistoryShared(chat.id, next).then(
			() => toasts.show(copy.admin.saved),
			() => {
				setShared(null);
				toasts.show(copy.common.failed);
			},
		);
	};
	return (
		<section className="card" aria-labelledby={id}>
			<h3 id={id}>{copy.admin.history}</h3>
			<div className="row">
				<Icon name="eye" />
				<span className="grow">
					{copy.admin.historyRow}
					<small>{copy.admin.historyNote}</small>
				</span>
				<Switch checked={value} label={copy.admin.historyRow} onChange={toggle} />
			</div>
		</section>
	);
}

/** Turns topics on; the server cannot turn them off, so the switch then stays on and locked. */
function TopicsCard({ chat }: { chat: Chat }) {
	const copy = useScreensCopy();
	const { remote, toasts } = useServices();
	const [turningOn, setTurningOn] = useState(false);
	const on = chat.forum || turningOn;
	const id = useDomId("topics");
	const enable = () => {
		setTurningOn(true);
		remote.enableTopics(chat.id).then(
			() => toasts.show(copy.admin.topicsEnabled),
			() => {
				setTurningOn(false);
				toasts.show(copy.common.failed);
			},
		);
	};
	return (
		<section className="card" aria-labelledby={id}>
			<h3 id={id}>{copy.admin.topics}</h3>
			<div className="row">
				<Icon name="hash" />
				<span className="grow">
					{copy.admin.topicsRow}
					<small>{chat.forum ? copy.admin.topicsOnNote : copy.admin.topicsNote}</small>
				</span>
				<Switch checked={on} label={copy.admin.topicsRow} disabled={on} onChange={enable} />
			</div>
		</section>
	);
}

function AdminRow({ chat, member, canDemote, onChanged }: { chat: Chat; member: Member; canDemote: boolean; onChanged: () => void }) {
	const copy = useScreensCopy();
	const { remote, store, toasts } = useServices();
	const inviter = useUser(member.inviterId === store.selfId ? 0 : member.inviterId);
	const [menu, setMenu] = useState(false);
	const self = member.person.id === store.selfId;
	const channel = chat.type === "channel";
	const name = self ? copy.common.you : member.person.name;
	const detail =
		member.role === "owner"
			? copy.admin.creator(channel)
			: member.inviterId !== 0
				? copy.admin.adminAddedBy(userName(inviter, store.selfId, copy, member.inviterId), channel)
				: copy.admin.adminPlain(channel);
	return (
		<div className="row">
			<ChatAvatar id={member.person.id} name={member.person.name} size="sm" />
			<span className="grow">
				{name}
				<small>{detail}</small>
			</span>
			{member.role === "owner" && <span className="tag">{copy.info.owner(channel)}</span>}
			{canDemote && member.role === "admin" && !self && (
				<span className="menu-anchor">
					<button
						type="button"
						className="icon-btn"
						aria-label={copy.admin.adminActions(member.person.name, channel)}
						aria-expanded={menu}
						onClick={() => setMenu((open) => !open)}
					>
						<Icon name="dots" />
					</button>
					{menu && (
						<div className="menu" role="menu">
							<button
								type="button"
								role="menuitem"
								className="danger"
								onClick={() => {
									setMenu(false);
									remote.setAdmin(chat.id, member.person.id, false).then(
										() => {
											toasts.show(copy.admin.demoted(member.person.name, channel));
											onChanged();
										},
										() => toasts.show(copy.common.failed),
									);
								}}
							>
								{copy.admin.demote(channel)}
							</button>
						</div>
					)}
				</span>
			)}
		</div>
	);
}

function AdminsCard({ chat }: { chat: Chat }) {
	const copy = useScreensCopy();
	const { remote, toasts } = useServices();
	const { members, status, reload } = useMembers(chat.id);
	const [picking, setPicking] = useState(false);
	const id = useDomId("admins");
	const admins = members.filter((m) => m.role !== "member");
	const others = members.filter((m) => m.role === "member" && !m.person.isBot);
	const owner = chat.myRole === "owner";
	const channel = chat.type === "channel";
	return (
		<section className="card" aria-labelledby={id}>
			<h3 id={id}>{copy.admin.admins(channel)}</h3>
			{status === "loading" && <p>{copy.common.loading}</p>}
			{status === "error" && <p>{copy.common.loadFailed}</p>}
			{admins.map((member) => (
				<AdminRow key={member.person.id} chat={chat} member={member} canDemote={owner} onChanged={reload} />
			))}
			<button type="button" className="btn btn-block" aria-expanded={picking} onClick={() => setPicking((open) => !open)}>
				<Icon name="user-plus" />
				{copy.admin.addAdmin(channel)}
			</button>
			{picking && (
				<div className="sub-form" role="group" aria-label={copy.admin.addAdminTitle(channel)}>
					<strong>{copy.admin.addAdminTitle(channel)}</strong>
					{others.map((member) => (
						<div className="row" key={member.person.id}>
							<ChatAvatar id={member.person.id} name={member.person.name} size="sm" />
							<span className="grow">{member.person.name}</span>
							<button
								type="button"
								className="btn btn-sm"
								onClick={() =>
									remote.setAdmin(chat.id, member.person.id, true).then(
										() => {
											toasts.show(copy.admin.promoted(member.person.name, channel));
											setPicking(false);
											reload();
										},
										() => toasts.show(copy.common.failed),
									)
								}
							>
								{copy.admin.promote(channel)}
							</button>
						</div>
					))}
				</div>
			)}
		</section>
	);
}

/** Links to the full member list and the banned list (#member-remove, #banned). */
function MembersCard({ chat }: { chat: Chat }) {
	const copy = useScreensCopy();
	const { remote } = useServices();
	const ui = useUi();
	const [banned, setBanned] = useState<{ count: number; more: boolean } | null>(null);
	const id = useDomId("members");
	const channel = chat.type === "channel";
	useEffect(() => {
		let active = true;
		remote.bannedMembers(chat.id).then(
			(page) => {
				if (active) setBanned({ count: page.items.length, more: page.nextCursor !== "" });
			},
			() => undefined,
		);
		return () => {
			active = false;
		};
	}, [remote, chat.id]);
	return (
		<section className="card" aria-labelledby={id}>
			<h3 id={id}>{copy.admin.members(channel)}</h3>
			<div className="row">
				<Icon name="users" />
				<button type="button" className="grow row-link" onClick={() => ui.dialog.set({ kind: "members", chatId: chat.id })}>
					{copy.admin.allMembers(channel)}
					<small>{copy.admin.allMembersSub(chat.memberCount)}</small>
				</button>
				<Icon name="chevron-right" small />
			</div>
			<div className="row">
				<Icon name="ban" />
				<Link to={paths.banned(chat.id)} className="grow row-link">
					{copy.admin.banned}
					<small>{banned === null ? copy.admin.bannedSubPlain : copy.admin.bannedSub(banned.count, banned.more)}</small>
				</Link>
				<Icon name="chevron-right" small />
			</div>
			<div className="row">
				<Icon name="user-plus" />
				<button type="button" className="grow row-link" onClick={() => ui.dialog.set({ kind: "addMembers", chatId: chat.id })}>
					{copy.admin.addMembersRow(channel)}
					<small>{copy.admin.addMembersSub}</small>
				</button>
				<Icon name="chevron-right" small />
			</div>
		</section>
	);
}

function LinksCard({ chat }: { chat: Chat }) {
	const copy = useScreensCopy();
	const { locale } = useI18n();
	const { remote, toasts } = useServices();
	const invites = useInviteLinks(chat.id);
	const [expiry, setExpiry] = useState<Expiry>("week");
	const [limit, setLimit] = useState("");
	const [busy, setBusy] = useState(false);
	const [now] = useState(Date.now);
	const id = useDomId("links");
	const usageLimit = /^\d+$/.test(limit.trim()) ? Number(limit.trim()) : 0;
	const create = () => {
		setBusy(true);
		const expiresAt = expiry === "never" ? 0 : Math.floor(Date.now() / 1000) + EXPIRY_SECONDS[expiry];
		remote
			.exportInvite(chat.id, expiresAt, usageLimit)
			.then(
				(invite) => {
					inviteLinks.add(chat.id, invite);
					setLimit("");
					toasts.show(copy.admin.linkCreated);
				},
				() => toasts.show(copy.common.failed),
			)
			.finally(() => setBusy(false));
	};
	return (
		<section className="card" aria-labelledby={id}>
			<h3 id={id}>{copy.admin.links}</h3>
			<p>{copy.admin.linksNote(chat.type === "channel")}</p>
			{invites.map((invite) => {
				const active = isActiveInvite(invite, now);
				return (
					<div className="row" key={invite.link}>
						<Icon name="link" />
						<span className="grow">
							<MiddleTruncate className={active ? "value" : "value muted"} text={displayLink(invite.link)} />
							<small>
								{copy.admin.linkMeta(
									invite.expiresAt === 0 ? copy.admin.noExpiry : copy.admin.expiresOn(shortDate(invite.expiresAt, locale)),
									copy.admin.used(invite.usageCount, invite.usageLimit),
								)}
							</small>
						</span>
						{active ? (
							<>
								<CopyButton text={invite.link} label={copy.admin.copyLink} copiedLabel={copy.info.copiedInvite} />
								<button
									type="button"
									className="icon-btn"
									aria-label={copy.admin.revoke}
									onClick={() =>
										remote.revokeInvite(chat.id, invite.link).then(
											(revoked) => {
												inviteLinks.replace(chat.id, revoked);
												toasts.show(copy.admin.revokedDone);
											},
											() => toasts.show(copy.common.failed),
										)
									}
								>
									<Icon name="trash" />
								</button>
							</>
						) : (
							<span className="tag grey">{invite.revoked ? copy.admin.revoked : copy.admin.expired}</span>
						)}
					</div>
				);
			})}
			<div className="sub-form" role="group" aria-labelledby={`${id}-new`}>
				<strong id={`${id}-new`}>{copy.admin.newLink}</strong>
				<div className="field">
					<span className="label">{copy.admin.expiresAfter}</span>
					<Choice
						label={copy.admin.expiresAfter}
						value={expiry}
						onChange={setExpiry}
						options={[
							{ value: "hour", label: copy.admin.hour },
							{ value: "day", label: copy.admin.day },
							{ value: "week", label: copy.admin.week },
							{ value: "never", label: copy.admin.never },
						]}
					/>
				</div>
				<div className="field">
					<label htmlFor={`${id}-limit`}>{copy.admin.usageLimit}</label>
					<input
						id={`${id}-limit`}
						className="input"
						type="number"
						min={1}
						inputMode="numeric"
						placeholder={copy.admin.unlimited}
						value={limit}
						onChange={(event) => setLimit(event.target.value)}
					/>
				</div>
				<div className="actions">
					<button type="button" className="btn btn-primary" aria-busy={busy} disabled={busy} onClick={create}>
						{copy.admin.createLink}
					</button>
				</div>
			</div>
		</section>
	);
}

/** "Tích hợp": the webhooks page, with how many run and their names (chat.html#chat-admin). */
function IntegrationsCard({ chat }: { chat: Chat }) {
	const copy = useScreensCopy();
	const { integrations } = useServices();
	const [summary, setSummary] = useState<{ total: number; running: readonly string[] } | null>(null);
	const id = useDomId("integrations");
	useEffect(() => {
		let active = true;
		integrations.hooks(chat.id).then(
			({ hooks }) => {
				if (active) setSummary({ total: hooks.length, running: hooks.filter((hook) => hook.state === "active").map((hook) => hook.name) });
			},
			() => undefined,
		);
		return () => {
			active = false;
		};
	}, [integrations, chat.id]);
	const sub =
		summary === null
			? ""
			: summary.total === 0
				? copy.admin.hooksNone
				: summary.running.length === 0
					? copy.admin.hooksStopped(summary.total)
					: copy.admin.hooksRunning(summary.running.length, summary.running.slice(0, 3).join(", "));
	return (
		<section className="card" aria-labelledby={id}>
			<h3 id={id}>{copy.admin.integrations}</h3>
			<div className="row">
				<Icon name="webhook" />
				<Link to={paths.hooks(chat.id)} className="grow row-link">
					{copy.admin.hooksRow}
					{sub !== "" && <small>{sub}</small>}
				</Link>
				<Icon name="chevron-right" small />
			</div>
		</section>
	);
}

/** Leaving (the leave dialog hands ownership over when the owner leaves) and, for the owner, deleting. */
function LeaveCard({ chat }: { chat: Chat }) {
	const copy = useScreensCopy();
	const ui = useUi();
	const id = useDomId("leave");
	const channel = chat.type === "channel";
	const owner = chat.myRole === "owner";
	return (
		<section className="card danger-zone" aria-labelledby={id}>
			<h3 id={id}>{copy.admin.leave(channel)}</h3>
			<p>{copy.admin.leaveNote(channel)}</p>
			{owner && <p>{copy.admin.deleteNote(channel)}</p>}
			<div className="actions">
				<button type="button" className="btn danger-text" onClick={() => ui.dialog.set({ kind: "leave", chatId: chat.id })}>
					<Icon name="logout" />
					{channel ? copy.info.leaveChannel : copy.info.leaveGroup}
				</button>
				{owner && (
					<button type="button" className="btn danger-text" onClick={() => ui.dialog.set({ kind: "deleteChat", chatId: chat.id })}>
						<Icon name="trash" />
						{copy.info.deleteGroup(channel)}
					</button>
				)}
			</div>
		</section>
	);
}

export function ChatAdmin({ chatId }: { chatId: number }) {
	const copy = useScreensCopy();
	const chat = useChat(chatId);
	const loader = useLoader(chat === undefined);
	if (loader !== null || chat == null) {
		return <section className="admin-page">{loader ?? <div className="empty">{copy.convo.notFound}</div>}</section>;
	}
	const admin = chat.myRole === "admin" || chat.myRole === "owner";
	const channel = chat.type === "channel";
	const role = chat.myRole === "owner" || chat.myRole === "admin" ? chat.myRole : null;
	const subtitle = [copy.admin.sub(chat.title, chat.memberCount, channel), role === null ? "" : copy.admin.youAre(role, channel)].filter(Boolean).join(" · ");
	return (
		<section className="admin-page" aria-label={channel ? copy.admin.channelTitle : copy.admin.groupTitle}>
			<div className="admin-head">
				<Link to={paths.chat(chatId)} className="icon-btn" aria-label={copy.admin.back(channel)}>
					<Icon name="back" />
				</Link>
				<ChatAvatar id={chatId} name={chat.title} />
				<div className="title">
					<strong>{channel ? copy.admin.channelTitle : copy.admin.groupTitle}</strong>
					<span title={subtitle}>{subtitle}</span>
				</div>
			</div>
			{admin ? (
				<div className="admin-grid">
					<div className="admin-col">
						{!channel && <PermissionsCard chat={chat} />}
						{!channel && <HistoryCard chat={chat} />}
						{!channel && <TopicsCard chat={chat} />}
						<AdminsCard chat={chat} />
						<MembersCard chat={chat} />
					</div>
					<div className="admin-col">
						<LinksCard chat={chat} />
						<IntegrationsCard chat={chat} />
						{!chat.left && <LeaveCard chat={chat} />}
					</div>
				</div>
			) : (
				<div className="empty">{copy.admin.notAdmin}</div>
			)}
		</section>
	);
}
