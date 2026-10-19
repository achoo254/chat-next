import type { ReactNode } from "react";
import type { SelfUser } from "../api/adapters.ts";
import { Avatar } from "../components/avatar.tsx";
import { Icon } from "../components/icon.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { Link, paths, type Route } from "../router.tsx";

interface ShellProps {
	self: SelfUser;
	route: Route;
	/** Extra rail links after Chats (the messaging UI adds Contacts). */
	nav?: ReactNode;
	/** The user's avatar with their photo (the messaging UI), in place of the initials. */
	avatar?: ReactNode;
	children: ReactNode;
}

/** Signed-in frame: navigation rail plus the active screen. */
export function Shell({ self, route, nav, avatar, children }: ShellProps) {
	const { t } = useI18n();
	return (
		<div className="shell">
			<nav className="rail" aria-label={t.shell.nav}>
				<span title={t.shell.account(self.name)}>
					{avatar ?? <Avatar name={self.name} size="sm" />}
					<span className="sr-only">{t.shell.account(self.name)}</span>
				</span>
				<Link to={paths.home} className="icon-btn" current={route.name === "home"} aria-label={t.shell.chats}>
					<Icon name="message" />
				</Link>
				{nav}
				<span className="spacer" />
				<Link
					to={paths.settingsList}
					className="icon-btn"
					current={route.name === "settings"}
					aria-label={t.shell.settings}
				>
					<Icon name="settings" />
				</Link>
			</nav>
			{children}
		</div>
	);
}
