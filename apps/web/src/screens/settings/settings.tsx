import type { SelfUser } from "../../api/adapters.ts";
import { Icon, type IconName } from "../../components/icon.tsx";
import { SignOutForm } from "../../components/sign-out-form.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { Link, paths, type SettingsTab } from "../../router.tsx";
import { ProfileSettings } from "./profile-settings.tsx";
import { SessionsSettings } from "./sessions-settings.tsx";

const TABS: { tab: SettingsTab; icon: IconName }[] = [
	{ tab: "profile", icon: "user" },
	{ tab: "sessions", icon: "laptop" },
];

interface SettingsProps {
	tab: SettingsTab;
	self: SelfUser;
	onSelfChange: (self: SelfUser) => void;
}

/** Settings: category list plus the selected category. */
export function Settings({ tab, self, onSelfChange }: SettingsProps) {
	const { t } = useI18n();
	return (
		<div className="set">
			<nav className="set-nav" aria-label={t.settings.categories}>
				<h2>{t.settings.title}</h2>
				{TABS.map((item) => (
					<Link key={item.tab} to={paths.settings(item.tab)} current={item.tab === tab}>
						<Icon name={item.icon} />
						<span>{t.settings[item.tab]}</span>
					</Link>
				))}
				<hr />
				<SignOutForm>
					<Icon name="logout" />
					<span>{t.settings.signOut}</span>
				</SignOutForm>
			</nav>
			<main className="set-main">
				<header className="set-head">
					<h1>{t.settings[tab]}</h1>
				</header>
				{tab === "profile" ? (
					<ProfileSettings self={self} onSelfChange={onSelfChange} />
				) : (
					<SessionsSettings />
				)}
			</main>
		</div>
	);
}
