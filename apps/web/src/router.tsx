// Minimal history-based routing: a handful of screens do not justify a router library.
import { useSyncExternalStore, type MouseEvent, type ReactNode } from "react";

export type SettingsTab = "profile" | "sessions" | "privacy" | "blocked" | "notifications" | "appearance" | "shortcuts" | "app" | "account";

/**
 * What the chat column shows next to the conversation list: the chat, its
 * admin page, the banned list, or the incoming webhooks (list, new, one hook).
 */
export type ChatPanel = "chat" | "admin" | "banned" | "hooks" | "hook-new" | "hook";

/** Developer Console pages: the bot list, a new bot, or one bot's section. */
export type ConsolePage =
	| { readonly page: "list" }
	| { readonly page: "new" }
	| { readonly page: "bot"; readonly botId: number; readonly tab: ConsoleTab };

export type ConsoleTab = "profile" | "token" | "updates" | "dead-letters" | "stats" | "commands";

export type Route =
	| { name: "home" }
	| { name: "settings"; tab: SettingsTab }
	/** topicId 0: the chat itself (or the default topic of a group with topics). */
	/** hookId: set for the "hook" panel only. */
	| { name: "chat"; chatId: number; topicId: number; panel: ChatPanel; hookId?: string }
	| { name: "invite"; token: string }
	/** userId 0: the list without a profile open. */
	| { name: "contacts"; userId: number }
	| { name: "moderation"; reportId: string | null; actions: boolean }
	/** The feedback users sent the assistant bot, in the moderation screen. */
	| { name: "feedback" }
	/** Operators' announcements through the assistant bot. */
	| { name: "announcements" }
	/** The moderation log, and one bot as the operators review it. */
	| { name: "moderationLog" }
	| { name: "moderationBot"; botId: number }
	| { name: "console"; view: ConsolePage }
	/** A bot deep link (/b/<username>?start=<param>); the start parameter is read from the query. */
	| { name: "bot"; username: string };

/** Tabs that exist before messaging ships (release R0). */
const SETTINGS_TABS: readonly SettingsTab[] = ["profile", "privacy", "blocked", "notifications", "appearance", "shortcuts", "app", "sessions", "account"];

export const paths = {
	home: "/",
	settings: (tab: SettingsTab) => `/settings/${tab}`,
	chat: (chatId: number) => `/c/${chatId}`,
	topic: (chatId: number, topicId: number) => `/c/${chatId}/t/${topicId}`,
	chatAdmin: (chatId: number) => `/c/${chatId}/admin`,
	banned: (chatId: number) => `/c/${chatId}/admin/banned`,
	hooks: (chatId: number) => `/c/${chatId}/admin/hooks`,
	hookNew: (chatId: number) => `/c/${chatId}/admin/hooks/new`,
	hook: (chatId: number, hookId: string) => `/c/${chatId}/admin/hooks/${hookId}`,
	contacts: (userId = 0) => (userId === 0 ? "/contacts" : `/contacts/${userId}`),
	/** The link the server hands out (…/join/<token>); "/+<token>" still opens. */
	invite: (token: string) => `/join/${token}`,
	console: () => "/console",
	consoleNew: () => "/console/new",
	consoleBot: (botId: number, tab: ConsoleTab = "profile") => (tab === "profile" ? `/console/${botId}` : `/console/${botId}/${tab}`),
	botLink: (username: string, startParam = "") => (startParam === "" ? `/b/${username}` : `/b/${username}?start=${encodeURIComponent(startParam)}`),
	moderation: (reportId?: string, actions = false) =>
		reportId === undefined ? "/moderation" : `/moderation/${encodeURIComponent(reportId)}${actions ? "/actions" : ""}`,
	feedback: () => "/moderation/feedback",
	announcements: () => "/moderation/announcements",
	moderationLog: () => "/moderation/log",
	moderationBot: (botId: number) => `/moderation/bots/${botId}`,
} as const;

const ID = /^[1-9][0-9]{0,15}$/;
const INVITE = /^\/(?:join\/|\+)([A-Za-z0-9_-]{4,128})$/;
const REPORT_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Public hook ids: "hk_" and letters or digits. */
const HOOK_ID = /^hk_[A-Za-z0-9]{1,32}$/;
/** Bot usernames in deep links (any case; the server stores them lowercase). */
const BOT_USERNAME = /^[A-Za-z0-9_]{5,32}$/;
const CONSOLE_TABS: readonly ConsoleTab[] = ["token", "updates", "dead-letters", "stats", "commands"];

function parseId(value: string | undefined): number | null {
	if (value === undefined || !ID.test(value)) return null;
	const id = Number(value);
	return Number.isSafeInteger(id) ? id : null;
}

function matchMessaging(path: string): Route | null {
	const invite = INVITE.exec(path);
	if (invite?.[1] !== undefined) return { name: "invite", token: invite[1] };
	const parts = path.split("/").slice(1);
	if (parts[0] === "contacts" && parts.length <= 2) {
		const userId = parts.length === 1 ? 0 : parseId(parts[1]);
		return userId === null ? null : { name: "contacts", userId };
	}
	if (parts[0] === "c") {
		const chatId = parseId(parts[1]);
		if (chatId === null) return null;
		if (parts.length === 2) return { name: "chat", chatId, topicId: 0, panel: "chat" };
		if (parts[2] === "admin") {
			if (parts.length === 3) return { name: "chat", chatId, topicId: 0, panel: "admin" };
			if (parts.length === 4 && parts[3] === "banned") return { name: "chat", chatId, topicId: 0, panel: "banned" };
			if (parts[3] === "hooks") {
				if (parts.length === 4) return { name: "chat", chatId, topicId: 0, panel: "hooks" };
				const hookId = parts[4] ?? "";
				if (parts.length === 5 && hookId === "new") return { name: "chat", chatId, topicId: 0, panel: "hook-new" };
				if (parts.length === 5 && HOOK_ID.test(hookId)) return { name: "chat", chatId, topicId: 0, panel: "hook", hookId };
			}
			return null;
		}
		const topicId = parseId(parts[3]);
		if (parts.length === 4 && parts[2] === "t" && topicId !== null) {
			return { name: "chat", chatId, topicId, panel: "chat" };
		}
		return null;
	}
	if (parts[0] === "b" && parts.length === 2) {
		const username = parts[1] ?? "";
		return BOT_USERNAME.test(username) ? { name: "bot", username } : null;
	}
	if (parts[0] === "console") {
		if (parts.length === 1) return { name: "console", view: { page: "list" } };
		if (parts.length === 2 && parts[1] === "new") return { name: "console", view: { page: "new" } };
		const botId = parseId(parts[1]);
		if (botId === null) return null;
		if (parts.length === 2) return { name: "console", view: { page: "bot", botId, tab: "profile" } };
		const tab = CONSOLE_TABS.find((candidate) => candidate === parts[2]);
		if (parts.length === 3 && tab !== undefined) return { name: "console", view: { page: "bot", botId, tab } };
		return null;
	}
	if (parts[0] === "moderation") {
		if (parts.length === 1) return { name: "moderation", reportId: null, actions: false };
		if (parts.length === 2 && parts[1] === "feedback") return { name: "feedback" };
		if (parts.length === 2 && parts[1] === "announcements") return { name: "announcements" };
		if (parts.length === 2 && parts[1] === "log") return { name: "moderationLog" };
		if (parts.length === 3 && parts[1] === "bots") {
			const botId = parseId(parts[2]);
			return botId === null ? null : { name: "moderationBot", botId };
		}
		const reportId = parts[1] === undefined ? "" : decodeURIComponent(parts[1]);
		if (!REPORT_ID.test(reportId)) return null;
		if (parts.length === 2) return { name: "moderation", reportId, actions: false };
		if (parts.length === 3 && parts[2] === "actions") return { name: "moderation", reportId, actions: true };
	}
	return null;
}

/**
 * Maps a pathname to a route; null for unknown paths. Messaging routes exist
 * only when the messaging UI is on, so the R0 shell keeps its exact routes.
 */
export function matchRoute(pathname: string): Route | null {
	const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
	if (path === "/") return { name: "home" };
	if (path === "/settings") return { name: "settings", tab: "profile" };
	if (path.startsWith("/settings/")) {
		const tab = path.slice("/settings/".length);
		const found = SETTINGS_TABS.find((candidate) => candidate === tab);
		return found === undefined ? null : { name: "settings", tab: found };
	}
	try {
		return matchMessaging(path);
	} catch {
		// decodeURIComponent throws on a malformed escape: treat as unknown.
		return null;
	}
}

/**
 * Where sign-in should come back to (the server's return_to): the page a
 * signed-out visitor opened, such as an invite link or a chat, when it is a
 * known route other than home; undefined otherwise. The server validates the
 * path again and keeps it across tabs, so the IdP may finish in another tab.
 */
export function returnPathFor(pathname: string, search = ""): string | undefined {
	const route = matchRoute(pathname);
	if (route === null || route.name === "home") return undefined;
	// A bot link carries its start parameter in the query.
	return route.name === "bot" && search !== "" ? pathname + search : pathname;
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	window.addEventListener("popstate", listener);
	return () => {
		listeners.delete(listener);
		window.removeEventListener("popstate", listener);
	};
}

/** `path` may carry a query ("/b/x?start=1"); the same path and query is a no-op. */
export function navigate(path: string, options: { replace?: boolean } = {}): void {
	if (path === window.location.pathname + window.location.search) return;
	if (options.replace) window.history.replaceState(null, "", path);
	else window.history.pushState(null, "", path);
	for (const listener of listeners) listener();
}

export function usePathname(): string {
	return useSyncExternalStore(subscribe, () => window.location.pathname);
}

/** The query ("?start=…"); re-renders when only the query changes. */
export function useSearch(): string {
	return useSyncExternalStore(subscribe, () => window.location.search);
}

interface LinkProps {
	to: string;
	className?: string;
	current?: boolean;
	"aria-label"?: string;
	title?: string;
	children: ReactNode;
}

/** In-app link: plain clicks navigate without a reload, modified clicks keep browser behaviour. */
export function Link({ to, className, current, title, children, ...rest }: LinkProps) {
	const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
		if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		event.preventDefault();
		navigate(to);
	};
	return (
		<a
			href={to}
			className={className}
			title={title}
			aria-current={current ? "page" : undefined}
			aria-label={rest["aria-label"]}
			onClick={onClick}
		>
			{children}
		</a>
	);
}
