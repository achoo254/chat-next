// Minimal history-based routing: three screens do not justify a router library.
import { useSyncExternalStore, type MouseEvent, type ReactNode } from "react";

export type Route =
	| { name: "home" }
	| { name: "settings"; tab: SettingsTab };

export type SettingsTab = "profile" | "sessions";

export const paths = {
	home: "/",
	settings: (tab: SettingsTab) => `/settings/${tab}`,
} as const;

/** Maps a pathname to a route; null for unknown paths. */
export function matchRoute(pathname: string): Route | null {
	const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
	switch (path) {
		case "/":
			return { name: "home" };
		case "/settings":
		case "/settings/profile":
			return { name: "settings", tab: "profile" };
		case "/settings/sessions":
			return { name: "settings", tab: "sessions" };
		default:
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
	children: ReactNode;
}

/** In-app link: plain clicks navigate without a reload, modified clicks keep browser behaviour. */
export function Link({ to, className, current, children, ...rest }: LinkProps) {
	const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
		if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		event.preventDefault();
		navigate(to);
	};
	return (
		<a
			href={to}
			className={className}
			aria-current={current ? "page" : undefined}
			aria-label={rest["aria-label"]}
			onClick={onClick}
		>
			{children}
		</a>
	);
}
