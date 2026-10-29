// The signed-in user's avatar as the button of the shared account menu
// (@achoo254/app-shell AccountMenu, as on Localman's top bar): name and
// email, Hồ sơ, Phiên đăng nhập, Cài đặt, the hoandat.com account pages
// (system browser in the native app) and Đăng xuất. In the folder rail, the
// compact rail of the settings screens and the narrow chat list's top bar
// (account-menu-slot.tsx, which loads this module); where its panel opens
// there is set in messaging.css and app.css.
//
// The shared button draws the IdP picture or an initial; Chat's own avatar
// (its photo or initials) is laid over it unless the IdP picture is what
// should show (drawsChatAvatar), and lets clicks through to the button.
import { AccountMenu, type AccountMenuEntry } from "@achoo254/app-shell";
import "@achoo254/app-shell/app-shell.css";
import type { ReactNode } from "react";
import type { SelfUser } from "../../api/adapters.ts";
import { brand } from "../../brand.ts";
import { Icon } from "../../components/screen-icons.tsx";
import { ShellRouterLink } from "../../components/shell-router-link.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { paths } from "../../router.tsx";
import { useServices } from "../data/services.tsx";

interface ChatAccountMenuProps {
	self: SelfUser;
	/**
	 * Opens the IdP pages in the native app's system browser; given by the
	 * slot, so this chunk does not import the platform layer it comes from.
	 */
	onOpenExternal: ((url: string) => void) | undefined;
	/** Chat's avatar laid over the shared one (drawsChatAvatar), or null. */
	photo: ReactNode;
}

export default function ChatAccountMenu({ self, onOpenExternal, photo }: ChatAccountMenuProps) {
	"use no memo";
	const { locale, t } = useI18n();
	const services = useServices();
	const entries: readonly AccountMenuEntry[] = [
		{ label: t.settings.profile, dataId: "account-menu-profile", href: paths.settings("profile"), icon: <Icon name="user" small /> },
		{ label: t.settings.sessions, dataId: "account-menu-sessions", href: paths.settings("sessions"), icon: <Icon name="laptop" small /> },
		{ label: t.shell.settings, dataId: "account-menu-settings", href: paths.settingsList, icon: <Icon name="settings" small /> },
	];
	return (
		<div className="chat-account">
			<AccountMenu
				user={{ name: self.name, email: self.email, picture: self.idpPicture }}
				locale={locale}
				domain={brand.domain}
				idpAccountUrl={brand.accountUrl}
				entries={[entries]}
				signOut={{ onClick: () => services.signOut() }}
				onOpenExternal={onOpenExternal}
				linkComponent={ShellRouterLink}
			/>
			{photo !== null && <span className="chat-account-photo">{photo}</span>}
		</div>
	);
}
