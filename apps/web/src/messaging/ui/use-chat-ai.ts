// The live side of a chat's AI panel: which of the user's machines runs it
// (the one picked last on this device, else the first online), that
// machine's link, and the chat's own AI Agent session there. A machine keeps
// one session per chat: the panel finds it in the machine's list by the
// chat's id (ThreadSummary.chat_id); the first question opens it with
// ThreadCreate{chat, dir ""}, in a folder the machine keeps for that chat.
// A machine whose tunelo predates chats (AGENT_CHAT_THREADS) would ignore the
// chat and open the session in its own working folder: nothing is created
// there, the panel asks for an update. Should such a machine still answer with
// a session that names no chat, the panel does not use it either.
import { useState } from "react";
import type { ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import type { Chat } from "@achoo254/chat-core";
import { brand } from "../../brand.ts";
import { AGENT_CHAT_THREADS, versionAtLeast } from "../../machines/agent-version.ts";
import type { LinkState, MachineLink } from "../../machines/link/machine-link.ts";
import type { Conn } from "../../machines/machine-status.ts";
import { sessionProvider, useHub, useHubPresence, useMachineViews, useNow, type MachineView } from "../../machines/use-machines.ts";

/**
 * The instructions the chat's session starts with, before the user's first
 * question. Written in Vietnamese for every UI language: the AI reads them,
 * not the user, and answers in the language the user writes in.
 */
export function chatContext(chat: Pick<Chat, "id" | "externalApp">, title: string): string {
	return [
		`Hội thoại: ${title}`,
		`Ứng dụng: ${chat.externalApp ?? brand.appName}`,
		`chat_id: ${chat.id}`,
		"Dùng các tool chat của tunelo (get_messages, search_messages, get_chat…) để đọc hội thoại này. Gợi ý trả lời chỉ là bản nháp. Chỉ gửi tin khi người dùng yêu cầu rõ ràng, và luôn qua tool gửi có thẻ duyệt.",
		"Tệp trong thư mục của phiên này gửi được vào hội thoại bằng chat_send_file, sau khi người dùng duyệt thẻ.",
		// Zalo takes only what the user types or attaches in the composer: no tool can post there.
		...(chat.externalApp === "zalo"
			? ["Hội thoại này ở Zalo: tool không gửi được tin hay tệp vào đây (Zalo chỉ nhận những gì người dùng tự gõ hoặc đính kèm ở ô soạn tin). Hãy soạn sẵn nội dung và bảo người dùng bấm «Đưa vào ô soạn tin» để tự gửi."]
			: []),
	].join("\n");
}

/** After the context, when a session is opened before any question (AI Agent › Liên hệ): the AI only says it is ready. */
export const CONTEXT_ONLY = "Chưa có câu hỏi nào: chỉ cần trả lời ngắn rằng bạn đã sẵn sàng.";

/** The chat's session among a machine's threads: the newest one naming the chat, not archived. */
export function chatThread(threads: readonly ThreadSummary[], chatId: number): ThreadSummary | null {
	const id = BigInt(chatId);
	return threads.find((thread) => thread.chatId === id && !thread.archived) ?? null;
}

/** Where this device keeps the machine picked for the AI panel, per user. */
function machineKey(selfId: number): string {
	return `chat:ai-machine:${selfId}`;
}

export function rememberedMachine(selfId: number): string {
	try {
		return window.localStorage.getItem(machineKey(selfId)) ?? "";
	} catch {
		return "";
	}
}

export function rememberMachine(selfId: number, ref: string): void {
	try {
		window.localStorage.setItem(machineKey(selfId), ref);
	} catch {
		// Storage off: the pick lasts until the tab closes.
	}
}

/** The machine the panel uses: the one picked (or picked last here) when still listed, else the first one online, else the first. */
export function pickTarget(views: readonly Pick<MachineView, "entry" | "conn">[], picked: string): string {
	if (picked !== "" && views.some((v) => v.entry.ref === picked)) return picked;
	const online = views.find((v) => v.conn.kind === "on") ?? views.find((v) => v.conn.kind === "connecting" || v.conn.kind === "retrying");
	return (online ?? views[0])?.entry.ref ?? "";
}

/**
 * What the panel can do now:
 * - loading: the machine list has not come yet;
 * - none: the account has no machine;
 * - offline: the machine is off (or this device cannot reach it);
 * - connecting: the link is opening, or the machine has not said what it has yet;
 * - ready: questions can go to the machine.
 */
export type ChatAiStatus = "loading" | "none" | "offline" | "connecting" | "ready";

export interface ChatAi {
	readonly status: ChatAiStatus;
	readonly machines: readonly MachineView[];
	/** The machine used; null before the list has one. */
	readonly target: MachineView | null;
	readonly pickMachine: (ref: string) => void;
	/** The chat's session on that machine; null before the first question. */
	readonly thread: ThreadSummary | null;
	/** The machine's tunelo does not know chats (too old, or it opened a session with no chat): nothing goes to it. */
	readonly outdated: boolean;
	/** The AI a new session opens with on that machine; "" when the machine has none signed in. */
	readonly provider: string;
	/** Opens the chat's session with the first question (context first); resolves to the session. */
	readonly start: (question: string) => Promise<ThreadSummary | null>;
}

function statusOf(directoryLoading: boolean, target: MachineView | null): ChatAiStatus {
	if (target === null) return directoryLoading ? "loading" : "none";
	const conn: Conn = target.conn;
	if (conn.kind === "on") return target.state.info === null || !target.state.listed ? "connecting" : "ready";
	if (conn.kind === "connecting" || conn.kind === "retrying") return "connecting";
	return "offline";
}

/** Opens the chat's session on `link` with `text` as its first message; null when the machine answered with no session. */
export async function createChatThread(link: MachineLink, state: LinkState, chat: Pick<Chat, "id" | "externalApp">, title: string, text: string): Promise<ThreadSummary | null> {
	const frame = await link.request({
		case: "threadCreate",
		value: {
			provider: sessionProvider(state.info, ""),
			model: "",
			dir: "",
			text,
			chat: { chatId: BigInt(chat.id), title, app: chat.externalApp ?? "" },
			consent: { sensitive: false, projectSettings: false, trustProject: false },
		},
	});
	return frame.body.case === "threadCreated" ? (frame.body.value.thread ?? null) : null;
}

export function useChatAi(chat: Pick<Chat, "id" | "externalApp">, title: string, selfId: number): ChatAi {
	const hub = useHub();
	useHubPresence(hub);
	const now = useNow();
	const views = useMachineViews(hub, now);
	const [picked, setPicked] = useState(() => rememberedMachine(selfId));
	const targetRef = pickTarget(views, picked);
	const target = views.find((v) => v.entry.ref === targetRef) ?? null;
	const loading = hub.directory().status === "loading";
	// The session this panel opened, until the machine lists it; and whether the machine named no chat for it.
	const [created, setCreated] = useState<{ readonly machine: string; readonly thread: ThreadSummary } | null>(null);

	const listed = target === null ? null : chatThread(target.state.threads, chat.id);
	const own = created !== null && created.machine === targetRef ? created.thread : null;
	// Known only once the machine described itself (status "connecting" until then).
	const tooOld = target?.state.info != null && !versionAtLeast(target.state.info.agentVersion, AGENT_CHAT_THREADS);
	const outdated = tooOld || (own !== null && own.chatId === 0n);
	const thread = tooOld ? null : (listed ?? (outdated ? null : own));
	const provider = target === null ? "" : sessionProvider(target.state.info, "");

	const pickMachine = (ref: string) => {
		setPicked(ref);
		rememberMachine(selfId, ref);
	};

	const start = async (question: string): Promise<ThreadSummary | null> => {
		if (target === null || outdated || target.state.info === null) return null;
		const opened = await createChatThread(target.link, target.state, chat, title, `${chatContext(chat, title)}\n\n${question}`);
		if (opened !== null) setCreated({ machine: target.entry.ref, thread: opened });
		return opened !== null && opened.chatId !== 0n ? opened : null;
	};

	return { status: statusOf(loading, target), machines: views, target, pickMachine, thread, outdated, provider, start };
}
