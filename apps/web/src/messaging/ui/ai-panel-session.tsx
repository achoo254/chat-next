// The chat's AI Agent session inside the AI panel: the AI Agent screens' own
// transcript and composer, loaded with their styles only when the panel
// shows a session, so the messaging code stays as small as it was.
import "../../machines/machines.css";
import { SessionChat } from "../../machines/session-chat.tsx";

export default function AiPanelSession({ machine, threadId, onUseText }: { machine: string; threadId: string; onUseText: (text: string) => Promise<boolean> }) {
	return <SessionChat machine={machine} threadId={threadId} mode="chat" onUseText={onUseText} />;
}
