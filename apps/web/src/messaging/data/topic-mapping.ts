// Server topics to the UI's Topic (loaded with the first topic list).
import { paths } from "../../router.tsx";
import { toneOf } from "./format.ts";
import type { Tone, Topic } from "./pending-backend.ts";
import type { ServerTopic, TopicTop } from "./remote.ts";
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

export function toTopic(chatId: number, topic: ServerTopic, tops: ReadonlyMap<number, TopicTop>, origin: string): Topic {
	const top = tops.get(topic.topSeq);
	return {
		id: topic.id,
		title: topic.title,
		icon: "hash",
		tone: toneForColor(topic.iconColor, topic.id),
		general: topic.id === GENERAL_TOPIC,
		pinned: topic.pinned,
		closed: topic.closed,
		hidden: topic.hidden,
		muted: false,
		unreadCount: topic.unreadCount,
		unreadMentions: 0,
		messageCount: 0,
		lastMessage: top === undefined ? null : { fromId: top.fromId, text: top.text, date: top.date },
		createdBy: topic.creatorId,
		createdAt: topic.createdAt,
		changedBy: 0,
		changedAt: 0,
		link: `${origin}${paths.topic(chatId, topic.id)}`,
	};
}

