// The chat's AI Agent session inside the AI panel: the AI Agent screens' own
// transcript and composer, loaded with their styles only when the panel
// shows a session, so the messaging code stays as small as it was.
import "../../machines/machines.css";
import { SessionChat, type SessionEmbed } from "../../machines/session-chat.tsx";

export default function AiPanelSession({ machine, threadId, embed }: { machine: string; threadId: string; embed: SessionEmbed }) {
	return <SessionChat machine={machine} threadId={threadId} mode="chat" embed={embed} />;
}
