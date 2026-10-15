// What a reaction pill shows (mockups/chat.html#rich-messages, Zalo
// placement): in private chats and groups of at most AVATAR_CHAT_MAX
// members, the emoji with up to three small avatars of the latest people
// who reacted ("+N" for the rest); in larger groups, in channels, or when
// the server did not send who reacted, the emoji with the count. In "Cloud
// của tôi" every reaction is your own, so only the emoji and count show. This is a
// display rule of the client, separate from the server's limit on who-read
// and who-reacted lists.
import type { Chat, ReactionCount } from "@app/core";

/** Largest group whose pills show avatars. */
export const AVATAR_CHAT_MAX = 10;
/** Avatars per pill. */
export const PILL_AVATARS = 3;

export type PillContent =
	| { readonly kind: "avatars"; readonly ids: readonly number[]; readonly more: number }
	| { readonly kind: "count"; readonly count: number };

/** Private chats and small groups show faces; channels and larger groups show counts. */
export function showsAvatars(chat: Pick<Chat, "type" | "memberCount"> | null): boolean {
	if (chat === null) return false;
	if (chat.type === "private" || chat.type === "secret") return true;
	return chat.type === "group" && chat.memberCount > 0 && chat.memberCount <= AVATAR_CHAT_MAX;
}

/** `saved`: the chat is "Cloud của tôi" (isSavedChat). */
export function pillContent(
	chat: Pick<Chat, "type" | "memberCount"> | null,
	reaction: Pick<ReactionCount, "count" | "recentUserIds">,
	saved = false,
): PillContent {
	const ids = reaction.recentUserIds.slice(0, PILL_AVATARS);
	if (saved || !showsAvatars(chat) || ids.length === 0) return { kind: "count", count: reaction.count };
	return { kind: "avatars", ids, more: Math.max(0, reaction.count - ids.length) };
}
