// Pure presentation helpers: chat kinds, names, avatar tones, times and
// one-line previews. No React, so they are unit-tested directly.
import type { Chat, DialogView, Message, MessageAction, User } from "@app/core";
import type { MessagingCopy } from "../copy/vi.ts";
import type { Tone } from "./pending-backend.ts";

export type ChatKind = "private" | "bot" | "group" | "forum" | "channel";
/** Built-in folders (R1): a client-side filter over the chat kind. */
export type Folder = "all" | "private" | "group" | "bot";

export const FOLDERS: readonly Folder[] = ["all", "private", "group", "bot"];

const TONES: readonly Tone[] = ["violet", "green", "blue", "amber", "cyan", "red", "grey"];

/** Stable avatar and sender colour for an id. */
export function toneOf(id: number): Tone {
	return TONES[Math.abs(id) % TONES.length] ?? "violet";
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

/** Whether a chat of `kind` belongs in `folder`. Channels only show under "all". */
export function inFolder(kind: ChatKind, folder: Folder): boolean {
	switch (folder) {
		case "all":
			return true;
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

export function actionText(action: MessageAction, actor: string, nameOf: NameOf, copy: MessagingCopy): string {
	const t = copy.system;
	switch (action.kind) {
		case "chat_created":
			return t.chatCreated(actor, action.title);
		case "members_added":
			return t.membersAdded(actor, joinNames(action.userIds.map(nameOf), t.and));
		case "member_left":
			return t.memberLeft(actor);
		case "member_removed":
			return t.memberRemoved(actor, nameOf(action.userId));
		case "title_changed":
			return t.titleChanged(actor, action.title);
		case "photo_changed":
			return t.photoChanged(actor);
		case "photo_removed":
			return t.photoRemoved(actor);
		case "message_pinned":
			return t.pinned(actor, "");
		case "history_visibility_changed":
			return action.visible ? t.historyOn(actor) : t.historyOff(actor);
		case "chat_mode_changed":
			return t.modeChanged;
		case "joined_by_invite":
			return t.joinedByInvite(actor);
		case "unsupported":
			return t.unsupported;
	}
}

function joinNames(names: readonly string[], and: string): string {
	if (names.length <= 1) return names[0] ?? "";
	return `${names.slice(0, -1).join(", ")}${and}${names[names.length - 1] ?? ""}`;
}

/** One-line preview of a message for the chat list and quotes. */
export function messagePreview(message: Message, nameOf: NameOf, copy: MessagingCopy): string {
	if (message.action !== null) return actionText(message.action, nameOf(message.fromId), nameOf, copy);
	if (message.text !== "") return oneLine(message.text);
	if (message.mediaKind !== null) return copy.message.mediaLater;
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

/**
 * Links to the tenant's own sites open directly; any other host asks first
 * (phase 6 security). The web app runs on chat.<domain>.
 */
export function isTrustedHost(host: string, appHost: string): boolean {
	if (host === "" || host === appHost) return true;
	const domain = appHost.startsWith("chat.") ? appHost.slice("chat.".length) : appHost;
	return host === domain || host.endsWith(`.${domain}`);
}
