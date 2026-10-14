// The full member list and removing a member (mockups/chat.html#member-remove).
// Admins open a member's menu: message privately, make admin, remove. Removing
// asks how: "Xoá và cấm vào lại" (the default: no invite link or re-adding
// works until an admin unbans, the person's invite links are revoked) or
// "Chỉ xoá" (they may come back with a link). Channels follow the same rules.
import { useState } from "react";
import { Icon } from "../../components/icon.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { navigate, paths } from "../../router.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import type { Member } from "../data/remote.ts";
import { useChat, useServices, useUser } from "../data/services.tsx";
import { Glyph } from "./glyphs.tsx";
import { membersChanged, useMembers } from "./members.ts";
import { ChatAvatar, DialogHead, Modal, useDomId } from "./parts.tsx";
import { PopupMenu } from "./popup-menu.tsx";
import { presenceText } from "./presence.tsx";
import { useUi } from "./ui-context.tsx";

interface CloseProps {
	onClose: () => void;
}

export function MembersDialog({ chatId, onClose }: CloseProps & { chatId: number }) {
	const copy = useScreensCopy();
	const { locale } = useI18n();
	const { remote, store, toasts } = useServices();
	const ui = useUi();
	const chat = useChat(chatId);
	const [query, setQuery] = useState("");
	const [menuFor, setMenuFor] = useState(0);
	const { members, status, hasMore, more } = useMembers(chatId, query.trim());
	const id = useDomId("members");
	const t = copy.members;
	const channel = chat?.type === "channel";
	const myRole = chat?.myRole ?? "member";
	const admin = myRole === "admin" || myRole === "owner";
	const canRemove = (member: Member) =>
		admin && member.person.id !== store.selfId && member.role !== "owner" && (member.role !== "admin" || myRole === "owner");
	const canPromote = (member: Member) => admin && member.role === "member" && !member.person.isBot;

	const message = (member: Member) => {
		remote.createPrivate(member.person.id).then(
			(privateChat) => {
				onClose();
				navigate(paths.chat(privateChat));
			},
			() => toasts.show(copy.common.failed),
		);
	};
	const promote = (member: Member) => {
		remote.setAdmin(chatId, member.person.id, true).then(
			() => {
				toasts.show(copy.admin.promoted(member.person.name));
				membersChanged(chatId);
			},
			() => toasts.show(copy.common.failed),
		);
	};

	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={channel ? t.titleChannel(chat?.memberCount ?? 0) : t.title(chat?.memberCount ?? 0)} onClose={onClose} />
			<div className="dlg-body stack">
				<label className="search-field">
					<Icon name="search" small />
					<span className="sr-only">{t.search(channel)}</span>
					<input type="search" placeholder={t.search(channel)} autoComplete="off" value={query} onChange={(event) => setQuery(event.target.value)} />
				</label>
				{status === "loading" && <p className="note">{copy.common.loading}</p>}
				{status === "error" && <p className="note">{copy.common.loadFailed}</p>}
				<ul className="member-list">
					{members.map((member) => {
						const self = member.person.id === store.selfId;
						const online = !member.person.isBot && (self || member.person.presence.kind === "online");
						const presence = member.person.isBot ? copy.info.bot : self ? copy.info.online : presenceText(member.person.presence, copy, locale);
						const actions = !self && (canRemove(member) || canPromote(member));
						return (
							<li key={member.person.id}>
								<div className="row">
									<ChatAvatar id={member.person.id} name={member.person.name} size="sm" bot={member.person.isBot} online={online} />
									<span className="grow">
										{self ? copy.common.you : member.person.name}
										<small className={online ? "on" : undefined}>{presence}</small>
									</span>
									{member.role === "owner" && <span className="tag">{copy.info.owner(channel)}</span>}
									{member.role === "admin" && <span className="tag grey">{copy.info.admin}</span>}
									{actions && (
										<button
											type="button"
											className="icon-btn"
											aria-label={t.actions(member.person.name)}
											aria-haspopup="menu"
											aria-expanded={menuFor === member.person.id}
											data-member-actions={member.person.id}
											// Its own menu's click-outside must not close it before this click toggles it.
											onPointerDown={(event) => {
												if (menuFor === member.person.id) event.stopPropagation();
											}}
											onClick={() => setMenuFor((open) => (open === member.person.id ? 0 : member.person.id))}
										>
											<Icon name="dots" />
										</button>
									)}
								</div>
								{menuFor === member.person.id && (
									<PopupMenu
										className="member-menu"
										label={t.actions(member.person.name)}
										onClose={() => {
											setMenuFor(0);
											document.querySelector<HTMLElement>(`[data-member-actions="${member.person.id}"]`)?.focus();
										}}
									>
										{!member.person.isBot && (
											<button type="button" role="menuitem" onClick={() => message(member)}>
												<Icon name="message" />
												{t.message}
											</button>
										)}
										{canPromote(member) && (
											<button
												type="button"
												role="menuitem"
												onClick={() => {
													setMenuFor(0);
													promote(member);
												}}
											>
												<Glyph name="key" />
												{t.makeAdmin}
											</button>
										)}
										{canRemove(member) && (
											<>
												<hr />
												<button
													type="button"
													role="menuitem"
													className="danger"
													onClick={() => ui.dialog.set({ kind: "removeMember", chatId, userId: member.person.id, back: true })}
												>
													<Glyph name="user-minus" />
													{t.remove(channel)}
												</button>
											</>
										)}
									</PopupMenu>
								)}
							</li>
						);
					})}
				</ul>
				{hasMore && (
					<button type="button" className="see-all" onClick={more}>
						{t.more}
					</button>
				)}
			</div>
		</Modal>
	);
}

interface RemoveProps extends CloseProps {
	chatId: number;
	userId: number;
	/** Opened from the member list: go back to it afterwards. */
	back: boolean;
}

export function RemoveMemberDialog({ chatId, userId, back, onClose }: RemoveProps) {
	const copy = useScreensCopy();
	const { remote, toasts } = useServices();
	const ui = useUi();
	const chat = useChat(chatId);
	const user = useUser(userId);
	const [busy, setBusy] = useState<"ban" | "only" | null>(null);
	const id = useDomId("remove");
	const t = copy.members;
	const channel = chat?.type === "channel";
	const name = user?.name ?? copy.message.unknownUser;
	const done = () => (back ? ui.dialog.set({ kind: "members", chatId }) : onClose());
	const remove = (ban: boolean) => {
		setBusy(ban ? "ban" : "only");
		remote.removeMember(chatId, userId, ban).then(
			() => {
				toasts.show(ban ? t.removedBan(name) : t.removedOnly(name, channel));
				membersChanged(chatId);
				done();
			},
			() => {
				setBusy(null);
				toasts.show(copy.common.failed);
			},
		);
	};
	const detail = [user?.username === undefined || user.username === "" ? "" : `@${user.username}`, chat?.title ?? ""].filter((part) => part !== "").join(" · ");
	return (
		<Modal labelledBy={id} onClose={done}>
			<DialogHead id={id} title={t.removeTitle(name, channel)} onClose={done} />
			<div className="dlg-body stack">
				<div className="result">
					<ChatAvatar id={userId} name={name} />
					<span>
						<b>{name}</b>
						{detail !== "" && <small>{detail}</small>}
					</span>
				</div>
				<div className="remove-way">
					<h3>{t.banWay}</h3>
					<ul className="effects">
						<li>
							<Icon name="ban" />
							<span>{t.banNoReturn(name)}</span>
						</li>
						<li>
							<Icon name="link" />
							<span>{t.banLinks(name)}</span>
						</li>
						<li>
							<Glyph name="refresh" />
							<span>{t.banUndo(channel)}</span>
						</li>
					</ul>
				</div>
				<div className="remove-way">
					<h3>{t.onlyWay}</h3>
					<ul className="effects">
						<li>
							<Glyph name="user-minus" />
							<span>{t.onlyReturn(name, channel)}</span>
						</li>
						<li>
							<Icon name="link" />
							<span>{t.onlyLinks(name)}</span>
						</li>
					</ul>
				</div>
			</div>
			<div className="dlg-foot">
				<button type="button" className="btn" onClick={done}>
					{copy.common.cancel}
				</button>
				<button type="button" className="btn" aria-busy={busy === "only"} disabled={busy !== null} onClick={() => remove(false)}>
					{t.removeOnly}
				</button>
				<button type="button" className="btn btn-danger" aria-busy={busy === "ban"} disabled={busy !== null} onClick={() => remove(true)}>
					{t.removeBan}
				</button>
			</div>
		</Modal>
	);
}
