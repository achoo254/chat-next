import { Fragment, useEffect, type ReactNode } from "react";
import type { SelfUser } from "../../api/adapters.ts";
import { Icon, type IconName } from "../../components/icon.tsx";
import { SignOutForm } from "../../components/sign-out-form.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { Link, navigate, paths, type SettingsTab } from "../../router.tsx";
import { ProfileSettings } from "./profile-settings.tsx";
import { SessionsSettings } from "./sessions-settings.tsx";

/** Tabs per group; groups are separated by a rule (mockups/settings.html). */
const R0_GROUPS: readonly (readonly { tab: SettingsTab; icon: IconName }[])[] = [
	[
		{ tab: "profile", icon: "user" },
		{ tab: "sessions", icon: "laptop" },
	],
];

const MESSAGING_GROUPS: readonly (readonly { tab: SettingsTab; icon: IconName }[])[] = [
	[
		{ tab: "profile", icon: "user" },
		{ tab: "privacy", icon: "eye-off" },
		{ tab: "blocked", icon: "ban" },
	],
	[
		{ tab: "notifications", icon: "bell" },
		{ tab: "appearance", icon: "sun" },
		{ tab: "shortcuts", icon: "command" },
	],
	[{ tab: "sessions", icon: "laptop" }],
];

/** Settings added by the messaging UI (release R1). */
export interface MessagingSettings {
	/** Renders the privacy, blocked, notifications, appearance and shortcuts tabs. */
	render: (tab: SettingsTab) => ReactNode;
	/** Wipes the local chat data before the sign-out route. */
	onSignOut: () => void;
	/** Shows the link to the moderation queue (operators only). */
	moderation: boolean;
}

type TabGroups = readonly (readonly { tab: SettingsTab; icon: IconName }[])[];

/** The tabs this session can use. */
function tabGroups(messaging: MessagingSettings | undefined): TabGroups {
	return messaging === undefined ? R0_GROUPS : MESSAGING_GROUPS;
}

interface SettingsProps {
	tab: SettingsTab;
	self: SelfUser;
	onSelfChange: (self: SelfUser) => void;
	messaging?: MessagingSettings;
}

/** Settings: category list plus the selected category. */
export function Settings({ tab, self, onSelfChange, messaging }: SettingsProps) {
	const { t } = useI18n();
	const groups = tabGroups(messaging);
	const available = groups.some((group) => group.some((item) => item.tab === tab));
	useEffect(() => {
		if (!available) navigate(paths.settings("profile"), { replace: true });
	}, [available]);
	let content: ReactNode;
	if (tab === "profile") content = <ProfileSettings self={self} onSelfChange={onSelfChange} />;
	else if (tab === "sessions") content = <SessionsSettings />;
	else content = messaging?.render(tab) ?? null;
	return (
		<div className="set">
			<nav className="set-nav" aria-label={t.settings.categories}>
				<h2>{t.settings.title}</h2>
				{groups.map((group, index) => (
					<Fragment key={group[0]?.tab ?? index}>
						{index > 0 && <hr />}
						{group.map((item) => (
							<Link key={item.tab} to={paths.settings(item.tab)} current={item.tab === tab}>
								<Icon name={item.icon} />
								<span>{t.settings[item.tab]}</span>
							</Link>
						))}
					</Fragment>
				))}
				{messaging !== undefined && (
					<Link to={paths.console()}>
						<Icon name="robot" />
						<span>{t.settings.console}</span>
					</Link>
				)}
				{messaging?.moderation === true && (
					<Link to={paths.moderation()}>
						<Icon name="shield" />
						<span>{t.settings.moderation}</span>
					</Link>
				)}
				<hr />
				{messaging === undefined ? (
					<SignOutForm>
						<Icon name="logout" />
						<span>{t.settings.signOut}</span>
					</SignOutForm>
				) : (
					<button type="button" onClick={messaging.onSignOut}>
						<Icon name="logout" />
						<span>{t.settings.signOut}</span>
					</button>
				)}
			</nav>
			<main className="set-main">
				<header className="set-head">
					<h1>{t.settings[tab]}</h1>
				</header>
				{content}
			</main>
		</div>
	);
}
