// Group and channel administration (mockups/chat.html#chat-admin): member
// permissions (a bitmask), history for new members, admins, invite links and
// leaving. Webhooks (R2) get their own page later.
import { useState } from "react";
import type { Chat } from "@app/core";
import { Icon, type IconName } from "../../components/icon.tsx";
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

function AdminRow({ chat, member, canDemote, onChanged }: { chat: Chat; member: Member; canDemote: boolean; onChanged: () => void }) {
	const copy = useScreensCopy();
	const { remote, store, toasts } = useServices();
	const inviter = useUser(member.inviterId === store.selfId ? 0 : member.inviterId);
	const [menu, setMenu] = useState(false);
	const self = member.person.id === store.selfId;
	const name = self ? copy.common.you : member.person.name;
	const detail =
		member.role === "owner"
			? copy.admin.creator
			: member.inviterId !== 0
				? copy.admin.adminAddedBy(userName(inviter, store.selfId, copy, member.inviterId))
				: copy.admin.adminPlain;
	return (
		<div className="row">
			<ChatAvatar id={member.person.id} name={member.person.name} size="sm" />
			<span className="grow">
				{name}
				<small>{detail}</small>
			</span>
			{canDemote && member.role === "admin" && !self && (
				<span className="menu-anchor">
					<button type="button" className="icon-btn" aria-label={copy.admin.adminActions(member.person.name)} aria-expanded={menu} onClick={() => setMenu((open) => !open)}>
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
											toasts.show(copy.admin.demoted(member.person.name));
											onChanged();
										},
										() => toasts.show(copy.common.failed),
									);
								}}
							>
								{copy.admin.demote}
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
	return (
		<section className="card" aria-labelledby={id}>
			<h3 id={id}>{copy.admin.admins}</h3>
			{status === "loading" && <p>{copy.common.loading}</p>}
			{status === "error" && <p>{copy.common.loadFailed}</p>}
			{admins.map((member) => (
				<AdminRow key={member.person.id} chat={chat} member={member} canDemote={owner} onChanged={reload} />
			))}
			<button type="button" className="btn btn-block" aria-expanded={picking} onClick={() => setPicking((open) => !open)}>
				<Icon name="user-plus" />
				{copy.admin.addAdmin}
			</button>
			{picking && (
				<div className="sub-form" role="group" aria-label={copy.admin.addAdminTitle}>
					<strong>{copy.admin.addAdminTitle}</strong>
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
											toasts.show(copy.admin.promoted(member.person.name));
											setPicking(false);
											reload();
										},
										() => toasts.show(copy.common.failed),
									)
								}
							>
								{copy.admin.promote}
							</button>
						</div>
					))}
				</div>
			)}
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
			<p>{copy.admin.linksNote}</p>
			{invites.map((invite) => {
				const active = isActiveInvite(invite, now);
				return (
					<div className="row" key={invite.link}>
						<Icon name="link" />
						<span className="grow">
							<span className={active ? "link-mono" : "link-mono muted"}>{displayLink(invite.link)}</span>
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

function DangerCard({ chat }: { chat: Chat }) {
	const copy = useScreensCopy();
	const ui = useUi();
	const id = useDomId("danger");
	return (
		<section className="card danger-zone" aria-labelledby={id}>
			<h3 id={id}>{copy.admin.danger}</h3>
			<p>{copy.admin.dangerNote}</p>
			<div className="actions">
				<button type="button" className="btn" onClick={() => ui.dialog.set({ kind: "leave", chatId: chat.id })}>
					{chat.type === "channel" ? copy.info.leaveChannel : copy.info.leaveGroup}
				</button>
				<button type="button" className="btn danger-text" disabled title={copy.admin.onlyCreator}>
					{copy.admin.deleteGroup}
				</button>
			</div>
		</section>
	);
}

export function ChatAdmin({ chatId }: { chatId: number }) {
	const copy = useScreensCopy();
	const chat = useChat(chatId);
	if (chat == null) {
		return (
			<section className="admin-page">
				<div className="empty">{chat === undefined ? <span className="spin" aria-hidden="true" /> : copy.convo.notFound}</div>
			</section>
		);
	}
	const admin = chat.myRole === "admin" || chat.myRole === "owner";
	const channel = chat.type === "channel";
	return (
		<section className="admin-page" aria-label={channel ? copy.admin.channelTitle : copy.admin.groupTitle}>
			<div className="admin-head">
				<Link to={paths.chat(chatId)} className="icon-btn" aria-label={copy.admin.back}>
					<Icon name="back" />
				</Link>
				<ChatAvatar id={chatId} name={chat.title} />
				<div className="title">
					<strong>{channel ? copy.admin.channelTitle : copy.admin.groupTitle}</strong>
					<span>{copy.admin.sub(chat.title, chat.memberCount)}</span>
				</div>
			</div>
			{admin ? (
				<div className="admin-grid">
					<div className="admin-col">
						{!channel && <PermissionsCard chat={chat} />}
						{!channel && <HistoryCard chat={chat} />}
						<AdminsCard chat={chat} />
					</div>
					<div className="admin-col">
						<LinksCard chat={chat} />
						<DangerCard chat={chat} />
					</div>
				</div>
			) : (
				<div className="empty">{copy.admin.notAdmin}</div>
			)}
		</section>
	);
}
