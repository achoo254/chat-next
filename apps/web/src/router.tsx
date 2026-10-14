// Minimal history-based routing: a handful of screens do not justify a router library.
import { useSyncExternalStore, type MouseEvent, type ReactNode } from "react";

export type SettingsTab = "profile" | "sessions" | "privacy" | "blocked" | "notifications";

/** What the chat column shows next to the conversation list. */
export type ChatPanel = "chat" | "admin" | "banned";

export type Route =
	| { name: "home" }
	| { name: "settings"; tab: SettingsTab }
	/** topicId 0: the chat itself (or the default topic of a group with topics). */
	| { name: "chat"; chatId: number; topicId: number; panel: ChatPanel }
	| { name: "invite"; token: string }
	/** userId 0: the list without a profile open. */
	| { name: "contacts"; userId: number }
	| { name: "moderation"; reportId: string | null; actions: boolean };

/** Tabs that exist before messaging ships (release R0). */
const SETTINGS_TABS: readonly SettingsTab[] = ["profile", "privacy", "blocked", "notifications", "sessions"];

export const paths = {
	home: "/",
	settings: (tab: SettingsTab) => `/settings/${tab}`,
	chat: (chatId: number) => `/c/${chatId}`,
	topic: (chatId: number, topicId: number) => `/c/${chatId}/t/${topicId}`,
	chatAdmin: (chatId: number) => `/c/${chatId}/admin`,
	banned: (chatId: number) => `/c/${chatId}/admin/banned`,
	contacts: (userId = 0) => (userId === 0 ? "/contacts" : `/contacts/${userId}`),
	invite: (token: string) => `/+${token}`,
	moderation: (reportId?: string, actions = false) =>
		reportId === undefined ? "/moderation" : `/moderation/${encodeURIComponent(reportId)}${actions ? "/actions" : ""}`,
} as const;

const ID = /^[1-9][0-9]{0,15}$/;
const INVITE = /^\/\+([A-Za-z0-9_-]{4,128})$/;
const REPORT_ID = /^[A-Za-z0-9_-]{1,64}$/;

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
			return null;
		}
		const topicId = parseId(parts[3]);
		if (parts.length === 4 && parts[2] === "t" && topicId !== null) {
			return { name: "chat", chatId, topicId, panel: "chat" };
		}
		return null;
	}
	if (parts[0] === "moderation") {
		if (parts.length === 1) return { name: "moderation", reportId: null, actions: false };
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

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	window.addEventListener("popstate", listener);
	return () => {
		listeners.delete(listener);
		window.removeEventListener("popstate", listener);
	};
}

export function navigate(path: string, options: { replace?: boolean } = {}): void {
	if (path === window.location.pathname) return;
	if (options.replace) window.history.replaceState(null, "", path);
	else window.history.pushState(null, "", path);
	for (const listener of listeners) listener();
}

export function usePathname(): string {
	return useSyncExternalStore(subscribe, () => window.location.pathname);
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
