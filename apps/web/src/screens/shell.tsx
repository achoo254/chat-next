import type { ReactNode } from "react";
import { EcosystemAppSwitcher } from "../components/ecosystem-app-switcher.tsx";
import { Icon } from "../components/icon.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { Link, paths, type Route } from "../router.tsx";

interface ShellProps {
	route: Route;
	/** Extra rail links after Chats (the messaging UI adds Contacts). */
	nav?: ReactNode;
	/** The user's avatar as the button of the account menu (the messaging UI). */
	account: ReactNode;
	/** The labelled folder rail (the messaging UI): shown on wide screens in place of the icon rail, which stays as the narrow top bar. */
	rail?: ReactNode;
	children: ReactNode;
}

/** Signed-in frame: navigation rail (with the switcher to the other apps) plus the active screen. */
export function Shell({ route, nav, account, rail, children }: ShellProps) {
	const { t } = useI18n();
	return (
		<div className={rail === undefined ? "app-frame" : "app-frame folders"}>
			{rail}
			<nav className="rail" aria-label={t.shell.nav}>
				{account}
				<Link to={paths.home} className="icon-btn" current={route.name === "home"} aria-label={t.shell.chats}>
					<Icon name="message" />
				</Link>
				{nav}
				<span className="spacer" />
				<EcosystemAppSwitcher placement="right-end" className="rail-switcher" />
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
