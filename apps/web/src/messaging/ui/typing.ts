// "đang gõ…" (mockups/chat.html #list-states and #app): the dialog list
// says it in place of the preview, the message list under the newest
// message.
import { useCopy } from "../copy/use-copy.ts";
import { GENERAL_TOPIC } from "../data/general-topic.ts";
import { useTyping, useUserNames } from "../data/services.tsx";

/**
 * What the chat shows while people type, "" when nobody does: the action
 * alone ("đang gõ…") when `named` is false (a private chat in the list),
 * otherwise with names ("Minh đang gõ…", "Minh và Lan đang gõ…", "3 người
 * đang gõ…"). A forum topic (topicId not null) counts only its own typing.
 */
export function useTypingText(chatId: number, named: boolean, topicId: number | null = null): string {
	const copy = useCopy();
	const all = useTyping(chatId);
	// A typing without a topic belongs to General.
	const list = topicId === null ? all : all.filter((t) => (t.topicId || GENERAL_TOPIC) === topicId);
	const names = useUserNames(named ? list.map((t) => t.userId) : []);
	const first = list[0];
	if (first === undefined) return "";
	const action = copy.typing[first.action];
	return named ? copy.typing.who(list.map((t) => names.get(t.userId) || copy.message.unknownUser), action) : action;
}
