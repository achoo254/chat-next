// Incoming webhooks of a group or channel (mockups/integrations.html),
// opened from "Quản lý nhóm" > Tích hợp or the info column, admins only:
// the list with the chat's log, a new webhook, and one webhook. Loaded on
// demand with its own styles, so none of it weighs on startup.
import { Icon } from "../../components/icon.tsx";
import { Link, paths, type ChatPanel } from "../../router.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { useChat } from "../data/services.tsx";
import { HookCreate } from "./hook-create.tsx";
import { HookDetail } from "./hook-detail.tsx";
import { HookList } from "./hook-list.tsx";
import { useHooksCopy } from "./use-hooks-copy.ts";
import "./integrations.css";

interface IntegrationsPageProps {
	chatId: number;
	panel: ChatPanel;
	/** The open hook (panel "hook"). */
	hookId: string;
}

export default function IntegrationsPage({ chatId, panel, hookId }: IntegrationsPageProps) {
	const copy = useScreensCopy();
	const t = useHooksCopy();
	const chat = useChat(chatId);
	if (chat == null) {
		return (
			<section className="admin-page">
				<div className="empty">{chat === undefined ? <span className="spin" aria-hidden="true" /> : copy.convo.notFound}</div>
			</section>
		);
	}
	const channel = chat.type === "channel";
	const admin = chat.myRole === "admin" || chat.myRole === "owner";
	const list = panel === "hooks";
	const titleId = `hooks-${chatId}`;
	return (
		<section className="admin-page hooks-page" aria-labelledby={titleId}>
			<div className="admin-head">
				<Link
					to={list ? paths.chatAdmin(chatId) : paths.hooks(chatId)}
					className="icon-btn"
					aria-label={list ? t.backToAdmin(channel) : t.backToList}
				>
					<Icon name="back" />
				</Link>
				<div className="title">
					<strong id={titleId}>{list ? t.title(channel) : panel === "hook-new" ? t.create : t.crumb}</strong>
					<span>{chat.title}</span>
				</div>
			</div>
			{!admin || (chat.type !== "group" && chat.type !== "channel") ? (
				<div className="empty">
					<Icon name="lock" />
					<span>{t.notAvailable}</span>
				</div>
			) : panel === "hook-new" ? (
				<HookCreate chat={chat} />
			) : panel === "hook" ? (
				<HookDetail key={hookId} chat={chat} hookId={hookId} />
			) : (
				<HookList chat={chat} />
			)}
		</section>
	);
}
