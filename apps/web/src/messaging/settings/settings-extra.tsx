// Settings tabs added with messaging (mockups/settings.html#privacy,
// #blocked, #notifications).
import { requestNotificationPermission } from "@app/platform-web";
import { useEffect, useState } from "react";
import { Icon } from "../../components/icon.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { Link, paths, type SettingsTab } from "../../router.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { useContacts } from "../data/contacts.ts";
import { shortDate } from "../data/format.ts";
import type { BlockedUser } from "../data/pending-backend.ts";
import type { Audience, Privacy } from "../data/remote.ts";
import { useServices } from "../data/services.tsx";
import { ContactsGlyph } from "../ui/contacts-glyph.tsx";
import { ChatAvatar, Choice, Switch } from "../ui/parts.tsx";

export default function SettingsExtra({ tab }: { tab: SettingsTab }) {
	switch (tab) {
		case "privacy":
			return <PrivacySettings />;
		case "blocked":
			return <BlockedSettings />;
		case "notifications":
			return <NotificationSettings />;
		default:
			return null;
	}
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
				{contacts.status === "ready" ? t.openContactsCount(contacts.people.length) : t.openContacts}
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
		return (
			<div className="set-body">
				{failed ? (
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
				) : (
					<p className="status">
						<span className="spin" aria-hidden="true" />
						{copy.common.loading}
					</p>
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

function BlockedSettings() {
	const copy = useScreensCopy();
	const { locale } = useI18n();
	const { backend, remote, toasts } = useServices();
	const supported = backend.features.has("blockedList");
	const [users, setUsers] = useState<readonly BlockedUser[] | null>(null);
	const [busy, setBusy] = useState(0);
	const t = copy.blocked;

	useEffect(() => {
		if (!supported) return;
		let active = true;
		backend.blockedUsers().then(
			(list) => {
				if (active) setUsers(list);
			},
			() => {
				if (active) setUsers([]);
			},
		);
		return () => {
			active = false;
		};
	}, [backend, supported]);

	const unblock = (user: BlockedUser) => {
		setBusy(user.id);
		remote.unblock(user.id).then(
			() => {
				setUsers((list) => (list ?? []).filter((item) => item.id !== user.id));
				toasts.show(t.unblocked(user.name));
				setBusy(0);
			},
			() => {
				setBusy(0);
				toasts.show(copy.common.failed);
			},
		);
	};

	return (
		<div className="set-body">
			<div className="card">
				{supported && users === null ? (
					<p className="status pad">
						<span className="spin" aria-hidden="true" />
						{copy.common.loading}
					</p>
				) : users !== null && users.length > 0 ? (
					<ul className="plain">
						{users.map((user) => (
							<li className="row pad-x" key={user.id}>
								<ChatAvatar id={user.id} name={user.name} bot={user.isBot} />
								<span className="grow">
									{user.name} {user.isBot && <span className="tag">{copy.info.bot}</span>}
									<small>{t.blockedOn(user.username, shortDate(user.blockedAt, locale))}</small>
								</span>
								<button type="button" className="btn btn-sm" aria-busy={busy === user.id} disabled={busy !== 0} onClick={() => unblock(user)}>
									{t.unblock}
								</button>
							</li>
						))}
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
			<div className="set-body">
				<p className="note">{t.whileOpen}</p>
			</div>
		</>
	);
}
