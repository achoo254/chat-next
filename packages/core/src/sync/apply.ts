// Turns one update into local writes (ADR 0002 update kinds, ADR 0009 purge).
// Pure with respect to the database: it only appends statements to the
// batch and records follow-up effects for the engine to run after commit.
import { EventKeys } from "../events/bus.ts";
import type { Message, SessionRevokeReason, UpdateBody } from "../model/types.ts";
import { purgeChat, purgeMessages } from "../purge/index.ts";
import {
	ensureDialog,
	putChat,
	putChatPts,
	putMessage,
	putNewMessage,
	putMute,
	putPin,
	putPinnedOrder,
	putReactions,
	putRead,
	type WriteBatch,
} from "../repo/writes.ts";

export interface Effects {
	/** Incoming messages applied from realtime (candidates for a notification). */
	readonly incoming: Message[];
	/** Chats the user is no longer in: drop in-memory sync state too. */
	readonly purgedChats: Set<number>;
	/** Chats whose entity must be fetched again (e.g. pinned_seq after an unpin). */
	readonly refreshChats: Set<number>;
	/** Large chats that have news in their own log. */
	readonly chatDifferences: Set<number>;
	/** Chats that switched to sync_mode=large, with the base chat_pts. */
	readonly modeChanges: Map<number, number>;
	/** Chats whose notifications can go (read elsewhere). */
	readonly readChats: Set<number>;
	sessionEnded: SessionRevokeReason | null;
}

export function newEffects(): Effects {
	return {
		incoming: [],
		purgedChats: new Set(),
		refreshChats: new Set(),
		chatDifferences: new Set(),
		modeChanges: new Map(),
		readChats: new Set(),
		sessionEnded: null,
	};
}

export interface ApplyContext {
	readonly w: WriteBatch;
	readonly selfId: number;
	readonly sessionId: number;
	readonly effects: Effects;
	/** Current per-chat log position of large chats (read-only here). */
	readonly chatPts: (chatId: number) => number | undefined;
}

/** Users and chats an update needs before it can be rendered. */
export function requiredEntities(body: UpdateBody, selfId: number): { users: number[]; chats: number[] } {
	switch (body.kind) {
		case "message_new":
		case "message_edit": {
			const m = body.message;
			const users = [m.fromId, m.viaBotId, m.forward?.fromUserId ?? 0];
			for (const entity of m.entities) if (entity.userId !== undefined) users.push(entity.userId);
			if (m.action?.kind === "members_added") users.push(...m.action.userIds);
			if (m.action?.kind === "member_removed") users.push(m.action.userId, m.action.by);
			return { users: users.filter((id) => id !== 0), chats: [m.chatId] };
		}
		case "member_added":
			return {
				users: [...body.userIds, body.inviterId].filter((id) => id !== 0),
				chats: body.userIds.includes(selfId) ? [body.chatId] : [],
			};
		default:
			return { users: [], chats: [] };
	}
}

export function applyBody(body: UpdateBody, ctx: ApplyContext): void {
	const { w, selfId, effects } = ctx;
	switch (body.kind) {
		case "message_new": {
			const m = body.message;
			putNewMessage(w, m, selfId);
			if (m.fromId === selfId && m.randomId !== 0) {
				// Our own message came back (another device or the echo of a send
				// whose response was lost): it is no longer pending here.
				w.add("DELETE FROM outbox WHERE kind = 'send' AND chat_id = ? AND random_id = ?", [m.chatId, m.randomId]);
				w.emit(EventKeys.outbox);
			}
			if (m.fromId !== selfId) effects.incoming.push(m);
			return;
		}
		case "message_edit":
			putMessage(w, body.message);
			return;
		case "message_delete":
		case "message_hidden":
			purgeMessages(w, body.chatId, body.seqs, selfId);
			return;
		case "reaction":
			putReactions(w, body.chatId, body.seq, body.reactions);
			return;
		case "read": {
			putRead(w, body, selfId);
			if (!body.outbox) {
				effects.readChats.add(body.chatId);
				// The counts were taken with the large chat's log at chatPts; a
				// client behind it pulls the rest (counted_through keeps the
				// pulled messages from being counted twice).
				const local = ctx.chatPts(body.chatId);
				if (local !== undefined && body.chatPts > local) effects.chatDifferences.add(body.chatId);
			}
			return;
		}
		case "pin":
			putPin(w, body.chatId, body.seq, body.pinned);
			// After an unpin the server may fall back to an older pinned message.
			if (!body.pinned) effects.refreshChats.add(body.chatId);
			return;
		case "member_added":
			// The chat entity was fetched before this update was applied
			// (requiredEntities); its history loads when the chat is opened.
			if (body.userIds.includes(selfId)) ensureDialog(w, body.chatId);
			return;
		case "member_removed":
			if (body.userId === selfId) {
				purgeChat(w, body.chatId);
				effects.purgedChats.add(body.chatId);
			}
			return;
		case "member_permissions":
			if (body.userId === selfId) {
				w.add("UPDATE chats SET my_role = ?, my_permissions = ? WHERE id = ?", [
					body.role,
					body.permissions,
					body.chatId,
				]);
				w.emit(EventKeys.chat(body.chatId));
			}
			return;
		case "chat_mode_changed":
			if (body.syncMode === "large") {
				w.add("UPDATE chats SET sync_mode = 'large' WHERE id = ?", [body.chatId]);
				putChatPts(w, body.chatId, body.chatPts);
				w.emit(EventKeys.chat(body.chatId));
				effects.modeChanges.set(body.chatId, body.chatPts);
			}
			return;
		case "chat_updated":
			putChat(w, body.chat);
			if (body.chat.left) {
				purgeChat(w, body.chat.id);
				effects.purgedChats.add(body.chat.id);
			}
			return;
		case "topic_changed":
			// Topics are listed from the server (GetForumTopics); tell the views.
			w.emit(EventKeys.chat(body.topic.chatId));
			return;
		case "chat_activity": {
			const local = ctx.chatPts(body.chatId);
			if (local === undefined || body.chatPts > local) effects.chatDifferences.add(body.chatId);
			return;
		}
		case "session_revoked":
			if (body.sessionId === ctx.sessionId) effects.sessionEnded = body.reason;
			return;
		case "dialog_mute":
			putMute(w, body.chatId, body.muteUntil);
			return;
		case "pinned_dialogs":
			putPinnedOrder(w, body.chatIds);
			return;
		case "chat_deleted":
			// Deleted for everyone, or a private chat the user cleared on
			// another session: either way nothing of it stays here. A cleared
			// private chat comes back with its next message.
			purgeChat(w, body.chatId);
			effects.purgedChats.add(body.chatId);
			return;
		case "unknown":
			// A kind newer than this build; the next release knows how to apply it.
			return;
	}
}
