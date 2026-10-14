// Server topics to the UI's Topic, and the paging of GetForumTopics (loaded
// with the first topic list).
import { paths } from "../../router.tsx";
import { toneOf } from "./format.ts";
import type { Tone, Topic, TopicIcon } from "./pending-backend.ts";
import type { Remote, ServerTopic, TopicTop } from "./remote.ts";
import { GENERAL_TOPIC } from "./general-topic.ts";

/** Nearest avatar tone for a topic's 0xRRGGBB colour (tones keep contrast in both themes). */
export function toneForColor(rgb: number, fallbackId: number): Tone {
	if (rgb <= 0) return toneOf(fallbackId);
	const r = ((rgb >> 16) & 0xff) / 255;
	const g = ((rgb >> 8) & 0xff) / 255;
	const b = (rgb & 0xff) / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	if (max - min < 0.12) return "grey";
	let hue: number;
	if (max === r) hue = ((g - b) / (max - min)) % 6;
	else if (max === g) hue = (b - r) / (max - min) + 2;
	else hue = (r - g) / (max - min) + 4;
	const degrees = (hue * 60 + 360) % 360;
	if (degrees < 20 || degrees >= 340) return "red";
	if (degrees < 65) return "amber";
	if (degrees < 170) return "green";
	if (degrees < 200) return "cyan";
	if (degrees < 255) return "blue";
	return "violet";
}

const ICONS: ReadonlySet<string> = new Set<TopicIcon>(["hash", "megaphone", "edit", "code", "flag", "inbox", "users", "database"]);

function isTopicIcon(name: string): name is TopicIcon {
	return ICONS.has(name);
}

/** The topic's glyph when the client has it; the default "#" otherwise (empty or newer names). */
export function topicIcon(name: string): TopicIcon {
	return isTopicIcon(name) ? name : "hash";
}

export function toTopic(chatId: number, topic: ServerTopic, tops: ReadonlyMap<number, TopicTop>, origin: string): Topic {
	const top = tops.get(topic.topSeq);
	return {
		id: topic.id,
		title: topic.title,
		icon: topicIcon(topic.icon),
		tone: toneForColor(topic.iconColor, topic.id),
		general: topic.id === GENERAL_TOPIC,
		pinned: topic.pinned,
		closed: topic.closed,
		hidden: topic.hidden,
		muted: false,
		unreadCount: topic.unreadCount,
		unreadMentions: topic.unreadMentions,
		messageCount: topic.messageCount,
		lastMessage: top === undefined ? null : { fromId: top.fromId, text: top.text, date: top.date },
		createdBy: topic.creatorId,
		createdAt: topic.createdAt,
		changedBy: 0,
		changedAt: 0,
		link: `${origin}${paths.topic(chatId, topic.id)}`,
	};
}

/** The loaded pages of a forum's topics. */
export interface TopicPages {
	readonly topics: readonly Topic[];
	/** "" when every topic is loaded. */
	readonly nextCursor: string;
	readonly pages: number;
}

async function fetchPage(remote: Remote, chatId: number, cursor: string, origin: string): Promise<{ topics: Topic[]; nextCursor: string }> {
	const page = await remote.forumTopics(chatId, cursor);
	const tops = new Map(page.tops.map((top) => [top.seq, top]));
	return { topics: page.topics.map((topic) => toTopic(chatId, topic, tops, origin)), nextCursor: page.nextCursor };
}

/** The first `pages` pages, loaded again (a reload keeps what the user scrolled to). */
export async function loadTopicPages(remote: Remote, chatId: number, pages: number, origin: string): Promise<TopicPages> {
	const topics: Topic[] = [];
	let cursor = "";
	let loaded = 0;
	do {
		const page = await fetchPage(remote, chatId, cursor, origin);
		topics.push(...page.topics);
		cursor = page.nextCursor;
		loaded++;
	} while (cursor !== "" && loaded < pages);
	return { topics, nextCursor: cursor, pages: loaded };
}

/** `current` plus its next page; a topic that moved between pages shows once, with its newest state. */
export async function loadNextTopicPage(remote: Remote, chatId: number, current: TopicPages, origin: string): Promise<TopicPages> {
	const page = await fetchPage(remote, chatId, current.nextCursor, origin);
	const ids = new Set(page.topics.map((topic) => topic.id));
	const kept = current.topics.filter((topic) => !ids.has(topic.id));
	return { topics: [...kept, ...page.topics], nextCursor: page.nextCursor, pages: current.pages + 1 };
}
