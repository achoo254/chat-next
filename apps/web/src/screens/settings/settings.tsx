import { Fragment, useEffect, type ReactNode } from "react";
import type { SelfUser } from "../../api/adapters.ts";
import { Avatar } from "../../components/avatar.tsx";
import { LoaderBoundary } from "../../components/delayed-loader.tsx";
import { ExternalLink } from "../../components/external-link.tsx";
import { Icon, type IconName } from "../../components/screen-icons.tsx";
import { SignOutForm } from "../../components/sign-out-form.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { Link, navigate, paths, type SettingsTab } from "../../router.tsx";
import { ProfileSettings } from "./profile-settings.tsx";

/** Tabs per group; groups are separated by a rule (mockups/settings.html). */
const R0_GROUPS: readonly (readonly { tab: SettingsTab; icon: IconName }[])[] = [[{ tab: "profile", icon: "user" }]];

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
	/** The "Góp ý" page: a settings tab like the others (docs/settings-menu.md). */
	feedback?: ReactNode;
}

/**
 * A settings entry with pages of its own (Developer Console, Kiểm duyệt):
 * shown in the settings frame like a tab, its pages switched by tabs inside
 * `content` (docs/settings-menu.md, rule 3).
 */
export interface SettingsSection {
	readonly id: "console" | "moderation";
	readonly title: string;
	readonly content: ReactNode;
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
	/** An entry with pages of its own, shown instead of `tab`. */
	section?: SettingsSection;
}

/** Settings: category list plus the selected category; on phones one of the two at a time. */
export function Settings({ tab, self, onSelfChange, messaging, list = false, section }: SettingsProps) {
	const { t } = useI18n();
	const groups = tabGroups(messaging);
	// "Kết nối AI" and "Tài khoản" (export, and the link to deletion at the IdP) follow the Developer Console link (mockups/settings.html#export-delete).
	const available =
		section !== undefined ||
		groups.some((group) => group.some((item) => item.tab === tab)) ||
		(messaging !== undefined && (tab === "mcp" || tab === "account")) ||
		(tab === "feedback" && messaging?.feedback !== undefined);
	/** Whether the entry for `item` is the one shown. */
	const isCurrent = (item: SettingsTab): boolean => section === undefined && item === tab;
	useEffect(() => {
		if (!available) navigate(paths.settings("profile"), { replace: true });
	}, [available]);
	let content: ReactNode;
	if (section !== undefined) content = section.content;
	else if (tab === "feedback") content = messaging?.feedback ?? null;
	else if (tab === "profile") content = <ProfileSettings self={self} onSelfChange={onSelfChange} photo={messaging?.photo} />;
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
							<Link key={item.tab} to={paths.settings(item.tab)} current={isCurrent(item.tab)}>
								<Icon name={item.icon} />
								<span>{t.settings[item.tab]}</span>
							</Link>
						))}
					</Fragment>
				))}
				{messaging !== undefined && (
					<>
						<Link to={paths.console()} current={section?.id === "console"}>
							<Icon name="robot" />
							<span>{t.settings.console}</span>
						</Link>
						<Link to={paths.settings("mcp")} current={isCurrent("mcp")}>
							<Icon name="plug" />
							<span>{t.settings.mcp}</span>
						</Link>
						<Link to={paths.settings("account")} current={isCurrent("account")}>
							<Icon name="key" />
							<span>{t.settings.account}</span>
						</Link>
					</>
				)}
				{messaging?.feedback !== undefined && (
					<Link to={paths.settings("feedback")} current={isCurrent("feedback")}>
						<Icon name="message-dot" />
						<span>{t.settings.feedback}</span>
					</Link>
				)}
				{messaging?.moderation === true && (
					<Link to={paths.moderation()} current={section?.id === "moderation"}>
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
					<h1>{section?.title ?? t.settings[tab]}</h1>
				</header>
				{/* A tab that loads shows one loader under the header; the first showing waits for it (messaging-root.tsx). */}
				<LoaderBoundary key={section?.id ?? tab}>{content}</LoaderBoundary>
			</main>
		</div>
	);
}
