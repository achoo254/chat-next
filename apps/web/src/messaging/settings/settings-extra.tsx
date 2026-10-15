// Settings tabs added with messaging (mockups/settings.html#privacy,
// #blocked, #notifications, #appearance, #shortcuts).
import type { NotificationSettings as CoreNotificationSettings, NotificationSound } from "@app/core";
import { requestNotificationPermission } from "@app/platform-web";
import { Fragment, useEffect, useState } from "react";
import { FONT_MAX, FONT_MIN, setFontSize, setTheme, storedFontSize, storedTheme, type Theme } from "../../appearance.ts";
import { BrandLoader } from "../../components/brand-loader.tsx";
import { Icon, type IconName } from "../../components/icon.tsx";
import { useI18n, type Locale } from "../../i18n/i18n.tsx";
import { Link, paths, type SettingsTab } from "../../router.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { useContacts } from "../data/contacts.ts";
import { clock } from "../data/format.ts";
import type { Audience, BlockedPerson, Privacy } from "../data/remote.ts";
import { setSoundInChat, useSoundInChat } from "../data/device-settings.ts";
import { useNotificationSettings, useServices } from "../data/services.tsx";
import { ContactsGlyph } from "../ui/contacts-glyph.tsx";
import { ChatAvatar, Choice, Switch, useDomId } from "../ui/parts.tsx";

export default function SettingsExtra({ tab }: { tab: SettingsTab }) {
	switch (tab) {
		case "privacy":
			return <PrivacySettings />;
		case "blocked":
			return <BlockedSettings />;
		case "notifications":
			return <NotificationSettings />;
		case "appearance":
			return <AppearanceSettings />;
		case "shortcuts":
			return <ShortcutSettings />;
		default:
			return null;
	}
}

/** dd/mm/yyyy of a unix second (the blocked list shows the year). */
function fullDate(unixSeconds: number, locale: string): string {
	const date = new Date(unixSeconds * 1000);
	const pad = (n: number) => String(n).padStart(2, "0");
	if (locale === "vi") return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
	return new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}

/** What "Danh bạ" means in every option below: the list you add people to yourself. */
function ContactsDefinition() {
	const copy = useScreensCopy();
	const { remote } = useServices();
	const contacts = useContacts(remote);
	const t = copy.privacy;
	return (
		<div className="card pad contacts-def">
			<ContactsGlyph />
			<p>
				<b>{t.contactsDefTitle}</b> {t.contactsDefBody}
			</p>
			<Link to={paths.contacts()} className="btn">
				{contacts.status === "ready" ? t.openContactsCount(contacts.entries.length) : t.openContacts}
			</Link>
		</div>
	);
}

type AudienceKey = "lastSeen" | "profilePhoto" | "findByEmail" | "findByUsername" | "addToGroups" | "sendMessages";

function PrivacySettings() {
	const copy = useScreensCopy();
	const { remote, toasts } = useServices();
	const [privacy, setPrivacy] = useState<Privacy | null>(null);
	const [failed, setFailed] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const t = copy.privacy;

	useEffect(() => {
		let active = true;
		remote.privacy().then(
			(value) => {
				if (active) setPrivacy(value);
			},
			() => {
				if (active) setFailed(true);
			},
		);
		return () => {
			active = false;
		};
	}, [remote, attempt]);

	const save = (change: Partial<Privacy>) => {
		if (privacy === null) return;
		const previous = privacy;
		setPrivacy({ ...privacy, ...change });
		remote.setPrivacy(change).then(
			(saved) => {
				setPrivacy(saved);
				toasts.show(t.saved);
			},
			() => {
				setPrivacy(previous);
				toasts.show(copy.common.failed);
			},
		);
	};

	if (privacy === null) {
		if (!failed) return <BrandLoader label={copy.common.loading} />;
		return (
			<div className="set-body">
				{failed && (
					<div className="banner error" role="alert">
						<Icon name="alert" small />
						<span className="grow">{copy.common.loadFailed}</span>
						<button
							type="button"
							className="btn btn-sm"
							onClick={() => {
								setFailed(false);
								setAttempt((n) => n + 1);
							}}
						>
							{copy.common.retry}
						</button>
					</div>
				)}
			</div>
		);
	}

	const options = [
		{ value: "everyone" as const, label: t.everyone },
		{ value: "contacts" as const, label: t.contacts },
		{ value: "nobody" as const, label: t.nobody },
	];
	const row = (key: AudienceKey, label: string, aria: string, hint?: string) => (
		<div className="row opt-row" key={key}>
			<span className="grow">
				{label}
				{hint !== undefined && <small>{hint}</small>}
			</span>
			<Choice<Audience> label={aria} value={privacy[key]} options={options} onChange={(value) => save({ [key]: value })} />
		</div>
	);
	return (
		<div className="set-body">
			<p className="lede">
				<Icon name="shield" small />
				{t.lede}
			</p>
			<ContactsDefinition />
			<div className="card">
				<h2 className="card-title">{t.whoSees}</h2>
				{row("lastSeen", t.lastSeen, t.whoLastSeen, t.lastSeenHint)}
				{row("profilePhoto", t.photo, t.whoPhoto)}
			</div>
			<div className="card">
				<h2 className="card-title">{t.whoFinds}</h2>
				{row("findByEmail", t.findByEmail, t.whoEmail, t.findByEmailHint)}
				{row("findByUsername", t.findByUsername, t.whoUsername, t.findByUsernameHint)}
				{row("addToGroups", t.addToGroups, t.whoGroups, t.addToGroupsHint)}
				{row("sendMessages", t.sendMessages, t.whoMessages, t.sendMessagesHint)}
			</div>
			<div className="card">
				<h2 className="card-title">{t.notifications}</h2>
				<div className="row pad-x">
					<span className="grow">
						{t.preview}
						<small>{t.previewHint}</small>
					</span>
					<Switch checked={privacy.notificationPreview} label={t.preview} onChange={(on) => save({ notificationPreview: on })} />
				</div>
				<div className="callout pad-x">
					<Icon name="lock" small />
					<p>{t.pushNote}</p>
				</div>
			</div>
		</div>
	);
}

type BlockedState =
	| { readonly status: "loading" }
	| { readonly status: "error" }
	| { readonly status: "ready"; readonly people: readonly BlockedPerson[]; readonly cursor: string };

/** People you blocked, most recent first (GetBlockedUsers), with Bỏ chặn. */
function BlockedSettings() {
	const copy = useScreensCopy();
	const { locale } = useI18n();
	const { remote, toasts } = useServices();
	const [state, setState] = useState<BlockedState>({ status: "loading" });
	const [attempt, setAttempt] = useState(0);
	const [busy, setBusy] = useState(0);
	const t = copy.blocked;

	useEffect(() => {
		let active = true;
		remote.blockedUsers().then(
			(page) => {
				if (active) setState({ status: "ready", people: page.items, cursor: page.nextCursor });
			},
			() => {
				if (active) setState({ status: "error" });
			},
		);
		return () => {
			active = false;
		};
	}, [remote, attempt]);

	const more = () => {
		if (state.status !== "ready" || state.cursor === "") return;
		remote.blockedUsers(state.cursor).then(
			(page) =>
				setState((current) => (current.status === "ready" ? { status: "ready", people: [...current.people, ...page.items], cursor: page.nextCursor } : current)),
			() => toasts.show(copy.common.failed),
		);
	};

	const unblock = ({ person }: BlockedPerson) => {
		setBusy(person.id);
		remote.unblock(person.id).then(
			() => {
				setState((current) => (current.status === "ready" ? { ...current, people: current.people.filter((item) => item.person.id !== person.id) } : current));
				toasts.show(t.unblocked(person.name));
				setBusy(0);
			},
			() => {
				setBusy(0);
				toasts.show(copy.common.failed);
			},
		);
	};

	if (state.status === "loading") return <BrandLoader label={copy.common.loading} />;
	return (
		<div className="set-body">
			<div className="card">
				{state.status === "error" ? (
					<div className="banner error" role="alert">
						<Icon name="alert" small />
						<span className="grow">{copy.common.loadFailed}</span>
						<button
							type="button"
							className="btn btn-sm"
							onClick={() => {
								setState({ status: "loading" });
								setAttempt((n) => n + 1);
							}}
						>
							{copy.common.retry}
						</button>
					</div>
				) : state.people.length > 0 ? (
					<ul className="plain">
						{state.people.map((entry) => (
							<li className="row pad-x" key={entry.person.id}>
								<ChatAvatar id={entry.person.id} name={entry.person.name} bot={entry.person.isBot} />
								<span className="grow">
									{entry.person.name} {entry.person.isBot && <span className="tag">{copy.info.bot}</span>}
									<small>{t.blockedOn(entry.person.username, fullDate(entry.blockedAt, locale))}</small>
								</span>
								<button
									type="button"
									className="btn btn-sm"
									aria-busy={busy === entry.person.id}
									disabled={busy !== 0}
									onClick={() => unblock(entry)}
								>
									{busy === entry.person.id ? t.unblocking : t.unblock}
								</button>
							</li>
						))}
						{state.cursor !== "" && (
							<li className="pad-x">
								<button type="button" className="see-all" onClick={more}>
									{t.more}
								</button>
							</li>
						)}
					</ul>
				) : (
					<div className="empty">
						<Icon name="ban" />
						<strong>{t.emptyTitle}</strong>
						<span>{t.blockHint}</span>
					</div>
				)}
			</div>
			<p className="note">{t.note}</p>
		</div>
	);
}

type PermissionState = NotificationPermission | "unsupported";

function currentPermission(): PermissionState {
	return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/** The browser's permission (top banner), per chat type on/off and preview, sound and badge (#notifications). */
function NotificationSettings() {
	const copy = useScreensCopy();
	const t = copy.notifications;
	const [permission, setPermission] = useState<PermissionState>(currentPermission);
	const ask = () => {
		requestNotificationPermission().then(setPermission, () => setPermission(currentPermission()));
	};
	return (
		<>
			{permission === "default" && (
				<div className="banner warn">
					<Icon name="alert-triangle" small />
					<span className="grow">{t.denied}</span>
					<button type="button" className="btn btn-sm" onClick={ask}>
						{t.allow}
					</button>
				</div>
			)}
			{permission === "denied" && (
				<div className="banner warn">
					<Icon name="alert-triangle" small />
					<span className="grow">{t.blockedByBrowser}</span>
				</div>
			)}
			{permission === "unsupported" && (
				<div className="banner warn">
					<Icon name="alert-triangle" small />
					<span className="grow">{t.unsupported}</span>
				</div>
			)}
			{permission === "granted" && (
				<div className="banner ok" role="status">
					<Icon name="check" small />
					<span className="grow">{t.granted}</span>
				</div>
			)}
			<NotificationOptions />
		</>
	);
}

type SettingsLoad = "loading" | "ready" | "error";

const CHAT_TYPES = [
	{ icon: "user", enabled: "privateEnabled", preview: "privatePreview" },
	{ icon: "users", enabled: "groupsEnabled", preview: "groupsPreview" },
	{ icon: "megaphone", enabled: "channelsEnabled", preview: "channelsPreview" },
] as const satisfies readonly { icon: IconName; enabled: keyof CoreNotificationSettings; preview: keyof CoreNotificationSettings }[];

/** The synced settings (Get/SetNotificationSettings) and the device-only sound in the open chat. */
function NotificationOptions() {
	const copy = useScreensCopy();
	const { store, self, toasts } = useServices();
	const synced = useNotificationSettings();
	const inChat = useSoundInChat(self.id);
	const [load, setLoad] = useState<SettingsLoad>("loading");
	const [attempt, setAttempt] = useState(0);
	// Changes on their way to the server, shown at once.
	const [pending, setPending] = useState<Partial<CoreNotificationSettings>>({});
	const t = copy.notifications;

	useEffect(() => {
		let active = true;
		store.loadNotificationSettings().then(
			() => {
				if (active) setLoad("ready");
			},
			() => {
				if (active) setLoad("error");
			},
		);
		return () => {
			active = false;
		};
	}, [store, attempt]);

	if (load !== "ready") {
		if (load !== "error") return <BrandLoader label={copy.common.loading} />;
		return (
			<div className="set-body">
				{load === "error" && (
					<div className="banner error" role="alert">
						<Icon name="alert" small />
						<span className="grow">{copy.common.loadFailed}</span>
						<button
							type="button"
							className="btn btn-sm"
							onClick={() => {
								setLoad("loading");
								setAttempt((n) => n + 1);
							}}
						>
							{copy.common.retry}
						</button>
					</div>
				)}
			</div>
		);
	}

	const settings: CoreNotificationSettings = { ...synced, ...pending };
	const save = (change: Partial<CoreNotificationSettings>) => {
		setPending((current) => ({ ...current, ...change }));
		const done = () =>
			setPending((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !(key in change))));
		store.setNotificationSettings(change).then(
			() => {
				done();
				toasts.show(t.saved);
			},
			() => {
				done();
				toasts.show(copy.common.failed);
			},
		);
	};
	const names = [t.private, t.groups, t.channels] as const;
	const hints = [t.privateHint, undefined, undefined] as const;
	const sounds: { value: NotificationSound; label: string }[] = [
		{ value: "default", label: t.soundDefault },
		{ value: "soft", label: t.soundSoft },
		{ value: "off", label: t.soundOff },
	];
	return (
		<div className="set-body">
			<div className="card">
				<h2 className="card-title">{t.byType}</h2>
				{CHAT_TYPES.map((type, index) => {
					const name = names[index] ?? "";
					const hint = hints[index];
					const enabled = settings[type.enabled];
					return (
						<Fragment key={type.enabled}>
							<div className="row pad-x">
								<span className="device">
									<Icon name={type.icon} />
								</span>
								<span className="grow">
									{name}
									{hint !== undefined && <small>{hint}</small>}
								</span>
								<Switch checked={enabled} label={t.typeSwitch(name)} onChange={(on) => save({ [type.enabled]: on })} />
							</div>
							<div className="row pad-x sub-row">
								<span className="grow">
									{t.preview}
									{!settings[type.preview] && <small>{t.previewOff}</small>}
								</span>
								<Switch
									checked={settings[type.preview]}
									disabled={!enabled}
									label={t.previewSwitch(name)}
									onChange={(on) => save({ [type.preview]: on })}
								/>
							</div>
						</Fragment>
					);
				})}
			</div>
			<div className="card">
				<h2 className="card-title">{t.soundAndCount}</h2>
				<div className="row opt-row">
					<span className="grow">{t.sound}</span>
					<Choice<NotificationSound> label={t.sound} value={settings.sound} options={sounds} onChange={(sound) => save({ sound })} />
				</div>
				<div className="row pad-x">
					<span className="grow">
						{t.soundInChat}
						<small>{t.soundInChatHint}</small>
					</span>
					<Switch checked={inChat} label={t.soundInChat} onChange={(on) => setSoundInChat(self.id, on)} />
				</div>
				<div className="row pad-x">
					<span className="grow">
						{t.badgeMuted}
						<small>{t.badgeMutedHint}</small>
					</span>
					<Switch checked={settings.badgeMuted} label={t.badgeMuted} onChange={(on) => save({ badgeMuted: on })} />
				</div>
			</div>
			<p className="note">{t.whileOpen}</p>
		</div>
	);
}

const THEMES: readonly Theme[] = ["light", "dark", "system"];
const LANGUAGES: readonly { locale: Locale; label: string }[] = [
	{ locale: "vi", label: "Tiếng Việt" },
	{ locale: "en", label: "English" },
];

/** Theme, language and message text size, kept on this device (#appearance). */
function AppearanceSettings() {
	const copy = useScreensCopy();
	const { locale, setLocale } = useI18n();
	const [theme, pickTheme] = useState<Theme>(storedTheme);
	const [size, pickSize] = useState(storedFontSize);
	const id = useDomId("font");
	const t = copy.appearance;
	const names: Record<Theme, string> = { light: t.light, dark: t.dark, system: t.system };
	return (
		<div className="set-body">
			<div className="card pad">
				<h2 className="card-title flush">{t.theme}</h2>
				<div className="theme-pick" role="group" aria-label={t.theme}>
					{THEMES.map((value) => (
						<button
							key={value}
							type="button"
							aria-pressed={theme === value}
							onClick={() => {
								setTheme(value);
								pickTheme(value);
							}}
						>
							<span className={`swatch sw-${value}`} aria-hidden="true">
								<i />
								<i />
							</span>
							{names[value]}
						</button>
					))}
				</div>
			</div>
			<div className="card">
				<div className="row opt-row">
					<span className="grow">
						{t.language}
						<small>{t.languageHint}</small>
					</span>
					<Choice<Locale>
						label={t.language}
						value={locale}
						options={LANGUAGES.map((language) => ({ value: language.locale, label: language.label }))}
						onChange={setLocale}
					/>
				</div>
			</div>
			<div className="card pad">
				<div className="size-head">
					<label htmlFor={id}>{t.fontSize}</label>
					<output htmlFor={id} className="mono">
						{t.px(size)}
					</output>
				</div>
				<div className="size-row">
					<span className="a-small" aria-hidden="true">
						A
					</span>
					<input
						id={id}
						type="range"
						min={FONT_MIN}
						max={FONT_MAX}
						step={1}
						value={size}
						onChange={(event) => {
							const next = Number(event.target.value);
							setFontSize(next);
							pickSize(next);
						}}
					/>
					<span className="a-big" aria-hidden="true">
						A
					</span>
				</div>
				<div className="size-preview" aria-hidden="true">
					<div className="msg">
						<ChatAvatar id={7} name={t.previewName} size="sm" />
						<div className="bubble">
							<span className="who">{t.previewName}</span>
							<p>
								{t.previewTheirs}
								<span className="stamp">{clock(1_760_000_520, locale)}</span>
							</p>
						</div>
					</div>
					<div className="msg mine">
						<div className="bubble">
							<p>
								{t.previewMine}
								<span className="stamp">{clock(1_760_000_580, locale)}</span>
							</p>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

type KeyOs = "mac" | "pc";

/** One key of a shortcut; "mod" and "alt" follow the platform (⌘/⌥ on macOS, Ctrl/Alt elsewhere). */
function Key({ name, os }: { name: string; os: KeyOs }) {
	const label = name === "mod" ? (os === "mac" ? "⌘" : "Ctrl") : name === "alt" ? (os === "mac" ? "⌥" : "Alt") : name;
	return <kbd>{label}</kbd>;
}

/** The keys that work in the web app (#shortcuts); ⌘/Ctrl+/ opens this tab from anywhere. */
function ShortcutSettings() {
	const copy = useScreensCopy();
	const [os, setOs] = useState<KeyOs>(() => (/Mac|iPhone|iPad/.test(navigator.userAgent) ? "mac" : "pc"));
	const t = copy.shortcuts;
	const rows = (items: readonly { label: string; hint?: string; keys: readonly (readonly string[])[]; joiner?: string; text?: string }[]) =>
		items.map((item) => (
			<div className="key-row" key={item.label}>
				<dt>
					{item.label}
					{item.hint !== undefined && <small>{item.hint}</small>}
				</dt>
				<dd>
					{item.text !== undefined && <span>{item.text}</span>}
					{item.keys.map((combo, index) => (
						<Fragment key={combo.join("+")}>
							{index > 0 && <span>{item.joiner ?? t.or}</span>}
							{combo.map((key) => (
								<Key key={key} name={key} os={os} />
							))}
						</Fragment>
					))}
				</dd>
			</div>
		));
	return (
		<div className="set-body">
			<div className="set-tools">
				<Choice<KeyOs>
					label={t.keyStyle}
					value={os}
					options={[
						{ value: "mac", label: t.mac },
						{ value: "pc", label: t.pc },
					]}
					onChange={setOs}
				/>
			</div>
			<p className="lede">
				<Icon name="command" small />
				<span>
					{t.ledeBefore} <Key name="mod" os={os} />
					<kbd>/</kbd> {t.ledeAfter}
				</span>
			</p>
			<div className="card">
				<h2 className="card-title">{t.findMove}</h2>
				<dl className="keys">
					{rows([
						{ label: t.search, keys: [["mod", "K"], ["mod", "F"]] },
						{ label: t.upDown, keys: [["alt", "↑"], ["alt", "↓"]], joiner: "/" },
						{ label: t.folders, keys: [["mod", "1"], ["5"]], joiner: "…" },
						{ label: t.list, keys: [["mod", "/"]] },
					])}
				</dl>
			</div>
			<div className="card">
				<h2 className="card-title">{t.compose}</h2>
				<dl className="keys">
					{rows([
						{ label: t.send, keys: [["Enter"]] },
						{ label: t.newline, keys: [["Shift", "Enter"]] },
						{ label: t.editLast, hint: t.editLastHint, keys: [["↑"]] },
						{ label: t.reply, keys: [], text: t.doubleClick },
						{ label: t.escape, keys: [["Esc"]] },
					])}
				</dl>
			</div>
		</div>
	);
}
