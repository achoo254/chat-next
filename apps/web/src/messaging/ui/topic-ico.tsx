// Topic icon and order, shared by the topic list, the conversation header
// and the topic info panel.
import { Icon } from "../../components/icon.tsx";
import type { Topic } from "../data/pending-backend.ts";

export function TopicIco({ topic, size }: { topic: Topic; size?: "sm" | "lg" }) {
	"use no memo";
	return (
		<span className={["topic-ico", size ?? "", `av-${topic.tone}`].filter(Boolean).join(" ")} aria-hidden="true">
			<Icon name={topic.icon} />
		</span>
	);
}

export function sortTopics(topics: readonly Topic[]): Topic[] {
	return [...topics].sort((a, b) => {
		if (a.general !== b.general) return a.general ? -1 : 1;
		if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
		return (b.lastMessage?.date ?? 0) - (a.lastMessage?.date ?? 0);
	});
}

