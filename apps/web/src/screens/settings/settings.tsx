import { Fragment, useEffect, useState, type ReactNode } from "react";
import type { SelfUser } from "../../api/adapters.ts";
import { Avatar } from "../../components/avatar.tsx";
import { LoaderBoundary } from "../../components/delayed-loader.tsx";
import { ExternalLink } from "../../components/external-link.tsx";
import { Icon, type IconName } from "../../components/screen-icons.tsx";
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
		{ tab: "app", icon: "download" },
	],
	[{ tab: "sessions", icon: "laptop" }],
];

/** Settings added by the messaging UI (release R1). */
export interface MessagingSettings {
	/** Renders the privacy, blocked, notifications, appearance, shortcuts and app tabs. */
	render: (tab: SettingsTab) => ReactNode;
	/** Wipes the local chat data before the sign-out route. */
	onSignOut: () => void;
	/** Shows the link to the moderation queue (operators only). */
	moderation: boolean;
	/** The profile photo field of the Profile tab. */
	photo?: ReactNode;
	/** The user's avatar with their photo, on the phone category list's account card. */
	avatar?: ReactNode;
	/** The "Góp ý" dialog (mockups/settings.html#feedback), shown over the current tab until closed. */
	feedback?: (onClose: () => void) => ReactNode;
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
	/** "/settings" itself: phones show only the category list (mockups/mobile.html#settings). */
	list?: boolean;
}

/** Settings: category list plus the selected category; on phones one of the two at a time. */
export function Settings({ tab, self, onSelfChange, messaging, list = false }: SettingsProps) {
	const { t } = useI18n();
	const groups = tabGroups(messaging);
	const [feedbackOpen, setFeedbackOpen] = useState(false);
	// "Tài khoản" (export and deletion) follows the Developer Console link (mockups/settings.html#export-delete).
	const available = groups.some((group) => group.some((item) => item.tab === tab)) || (messaging !== undefined && tab === "account");
	useEffect(() => {
		if (!available) navigate(paths.settings("profile"), { replace: true });
	}, [available]);
	let content: ReactNode;
	if (tab === "profile") content = <ProfileSettings self={self} onSelfChange={onSelfChange} photo={messaging?.photo} />;
	else if (tab === "sessions") content = <SessionsSettings />;
	else content = messaging?.render(tab) ?? null;
	return (
		<div className="set" data-view={list ? "list" : "page"}>
			<nav className="set-nav" aria-label={t.settings.categories}>
				<h2>{t.settings.title}</h2>
				<Link to={paths.settings("profile")} className="set-account">
					{messaging?.avatar ?? <Avatar name={self.name} size="sm" />}
					<span className="grow">
						<b>{self.name}</b>
						{self.username !== "" && <small>@{self.username}</small>}
					</span>
					<Icon name="chevron-right" small />
				</Link>
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
					<>
						<Link to={paths.console()}>
							<Icon name="robot" />
							<span>{t.settings.console}</span>
						</Link>
						<Link to={paths.settings("account")} current={tab === "account"}>
							<Icon name="key" />
							<span>{t.settings.account}</span>
						</Link>
					</>
				)}
				{messaging?.feedback !== undefined && (
					<button type="button" onClick={() => setFeedbackOpen(true)} aria-haspopup="dialog">
						<Icon name="message-dot" />
						<span>{t.settings.feedback}</span>
					</button>
				)}
				{messaging?.moderation === true && (
					<Link to={paths.moderation()}>
						<Icon name="shield" />
						<span>{t.settings.moderation}</span>
					</Link>
				)}
				<hr />
				{/* A new tab, so reading them leaves the app as it is. */}
				<ExternalLink href={paths.privacy} className="set-legal">
					<Icon name="shield" />
					<span className="grow">{t.legal.privacy}</span>
				</ExternalLink>
				<ExternalLink href={paths.terms} className="set-legal">
					<Icon name="file" />
					<span className="grow">{t.legal.terms}</span>
				</ExternalLink>
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
					<Link to={paths.settingsList} className="icon-btn set-back" aria-label={t.settings.back}>
						<Icon name="back" />
					</Link>
					<h1>{t.settings[tab]}</h1>
				</header>
				{/* A tab that loads shows one loader under the header; the first showing waits for it (messaging-root.tsx). */}
				<LoaderBoundary key={tab}>{content}</LoaderBoundary>
			</main>
			{feedbackOpen && messaging?.feedback?.(() => setFeedbackOpen(false))}
		</div>
	);
}
