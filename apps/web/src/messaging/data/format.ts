// Pure presentation helpers: chat kinds, names, avatar tones, times and
// one-line previews. No React, so they are unit-tested directly.
import type { Chat, DialogView, Message, MessageAction, User } from "@app/core";
import type { MessagingCopy } from "../copy/vi.ts";
import type { Tone } from "./pending-backend.ts";

export type ChatKind = "private" | "bot" | "group" | "forum" | "channel";
/** Built-in folders (R1): client-side filters over the chat kind, and "unread" over the read state. */
export type Folder = "all" | "private" | "group" | "bot" | "unread";

/** In rail order; Ctrl/⌘+1…5 picks them by position. */
export const FOLDERS: readonly Folder[] = ["all", "private", "group", "bot", "unread"];

const TONES: readonly Tone[] = ["violet", "green", "blue", "amber", "cyan", "red", "grey"];

/** Stable avatar and sender colour for an id. */
export function toneOf(id: number): Tone {
	return TONES[Math.abs(id) % TONES.length] ?? "violet";
}

/** Avatar colour of an incoming webhook, from its name: the same in the chat and in its settings. */
export function integrationTone(label: string): Tone {
	let hash = 0;
	for (const char of label) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 1_000_003;
	return toneOf(hash);
}

export function chatKind(chat: Chat | null, peer: User | null, forum: boolean): ChatKind {
	switch (chat?.type) {
		case "group":
			return forum ? "forum" : "group";
		case "channel":
			return "channel";
		default:
			return peer?.isBot === true ? "bot" : "private";
	}
}

/** Whether a chat of `kind` belongs in `folder`. Channels show under "all" and, when unread, "unread". */
export function inFolder(kind: ChatKind, folder: Folder, unread: boolean): boolean {
	switch (folder) {
		case "all":
			return true;
		case "unread":
			return unread;
		case "private":
			return kind === "private";
		case "group":
			return kind === "group" || kind === "forum";
		case "bot":
			return kind === "bot";
	}
}

export function dialogTitle(view: Pick<DialogView, "chat" | "peer">, copy: MessagingCopy): string {
	if (view.chat !== null && view.chat.title !== "") return view.chat.title;
	if (view.peer !== null) return view.peer.name;
	return copy.list.deletedChat;
}

export function userName(user: User | undefined, selfId: number, copy: MessagingCopy, userId: number): string {
	if (userId === selfId) return copy.common.you;
	return user?.name ?? copy.message.unknownUser;
}

function startOfDay(date: Date): number {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

const DAY_MS = 86_400_000;

function daysBetween(then: Date, now: Date): number {
	return Math.round((startOfDay(now) - startOfDay(then)) / DAY_MS);
}

/** HH:mm in the user's time zone. */
export function clock(unixSeconds: number, locale: string): string {
	return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
		unixSeconds * 1000,
	);
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** Short date of lists and admin rows: 03/10 in Vietnamese (ICU builds differ on the separator). */
export function shortDate(unixSeconds: number, locale: string): string {
	const date = new Date(unixSeconds * 1000);
	if (locale === "vi") return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}`;
	return new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit" }).format(date);
}

/** Chat list time: 09:42, Hôm qua, T2, 03/10 (mockups/chat.html#app). */
export function listTime(unixSeconds: number, now: Date, locale: string, copy: MessagingCopy): string {
	if (unixSeconds <= 0) return "";
	const then = new Date(unixSeconds * 1000);
	const days = daysBetween(then, now);
	if (days <= 0) return clock(unixSeconds, locale);
	if (days === 1) return copy.list.yesterday;
	if (days < 7) return copy.time.weekdays[then.getDay()] ?? shortDate(unixSeconds, locale);
	return shortDate(unixSeconds, locale);
}

/** Day separator in the message list: Hôm nay, Hôm qua, Thứ Hai, 12/10. */
export function dayLabel(unixSeconds: number, now: Date, locale: string, copy: MessagingCopy): string {
	const then = new Date(unixSeconds * 1000);
	const days = daysBetween(then, now);
	if (days <= 0) return copy.list.today;
	if (days === 1) return copy.list.yesterday;
	const weekday = new Intl.DateTimeFormat(locale, { weekday: "long" }).format(then);
	const year = then.getFullYear() === now.getFullYear() ? "" : `/${then.getFullYear()}`;
	const label = `${weekday}, ${shortDate(unixSeconds, locale)}${year}`;
	return label.charAt(0).toLocaleUpperCase(locale) + label.slice(1);
}

export function sameDay(a: number, b: number): boolean {
	return startOfDay(new Date(a * 1000)) === startOfDay(new Date(b * 1000));
}

/** First line of a text, whitespace collapsed, for previews and quotes. */
export function oneLine(text: string, max = 140): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** Names of the users a system message talks about. */
export type NameOf = (userId: number) => string;

/** Text of a system message; `channel` names the chat a channel instead of a group. */
export function actionText(action: MessageAction, actor: string, nameOf: NameOf, copy: MessagingCopy, channel: boolean): string {
	const t = copy.system;
	switch (action.kind) {
		case "chat_created":
			return t.chatCreated(actor, action.title, channel);
		case "members_added":
			return t.membersAdded(actor, joinNames(action.userIds.map(nameOf), t.and));
		case "member_left":
			return t.memberLeft(actor, channel);
		case "member_removed":
			return t.memberRemoved(actor, nameOf(action.userId), channel);
		case "title_changed":
			return t.titleChanged(actor, action.title, channel);
		case "photo_changed":
			return t.photoChanged(actor, channel);
		case "photo_removed":
			return t.photoRemoved(actor, channel);
		case "message_pinned":
			return t.pinned(actor, "");
		case "history_visibility_changed":
			return action.visible ? t.historyOn(actor) : t.historyOff(actor);
		case "chat_mode_changed":
			return t.modeChanged;
		case "joined_by_invite":
			return t.joinedByInvite(actor);
		case "incoming_hook_stopped":
			return t.hookStopped(actor, action.hookName, action.reason, channel);
		case "unsupported":
			return t.unsupported;
	}
}

export function joinNames(names: readonly string[], and: string): string {
	if (names.length <= 1) return names[0] ?? "";
	return `${names.slice(0, -1).join(", ")}${and}${names[names.length - 1] ?? ""}`;
}

/** One-line preview of a message for the chat list and quotes; `channel` as in actionText. */
export function messagePreview(message: Message, nameOf: NameOf, copy: MessagingCopy, channel: boolean): string {
	if (message.action !== null) return actionText(message.action, nameOf(message.fromId), nameOf, copy, channel);
	if (message.recalled) return copy.message.recalled;
	if (message.text !== "") return oneLine(message.text);
	if (message.mediaKind !== null) {
		const name = message.media?.fileName ?? "";
		const kind = copy.message.mediaKind[message.mediaKind];
		return message.mediaKind === "document" && name !== "" ? `${kind}: ${name}` : kind;
	}
	return copy.message.unsupportedTitle;
}

/** The host a link opens, or "" when it is not a URL. */
export function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return "";
	}
}

/** The tenant's domain: the web app runs on chat.<domain>. */
export function orgDomain(appHost: string): string {
	return appHost.startsWith("chat.") ? appHost.slice("chat.".length) : appHost;
}

/** Links to the tenant's own sites open directly; any other host asks first (phase 6 security). */
export function isTrustedHost(host: string, appHost: string): boolean {
	if (host === "" || host === appHost) return true;
	const domain = orgDomain(appHost);
	return host === domain || host.endsWith(`.${domain}`);
}

/** Every user a message preview or system line names (sender, added or removed members). */
export function namedUserIds(message: Message): number[] {
	const ids = [message.fromId];
	const action = message.action;
	if (action?.kind === "members_added") ids.push(...action.userIds);
	if (action?.kind === "member_removed") ids.push(action.userId);
	return ids;
}

/** Unread and mention counts stop at 1000 on the server; the cap reads "999+". */
export function countLabel(count: number): string {
	return count >= 1000 ? "999+" : String(count);
}
