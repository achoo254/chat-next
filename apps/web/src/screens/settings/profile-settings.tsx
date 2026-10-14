import { Code } from "@connectrpc/connect";
import { useId, useState, type FormEvent } from "react";
import type { SelfUser } from "../../api/adapters.ts";
import { useApi } from "../../api/api-context.tsx";
import { errorCode, type ProfileChanges } from "../../api/client.ts";
import { brand } from "../../brand.ts";
import { Avatar } from "../../components/avatar.tsx";
import { ExternalLink } from "../../components/external-link.tsx";
import { Icon } from "../../components/icon.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import type { Messages } from "../../i18n/vi.ts";

export const USERNAME_PATTERN = /^[a-z0-9_]{3,32}$/;
const NAME_MAX = 64;
const BIO_MAX = 140;

/** Client-side username check; the server still decides availability. */
export function usernameProblem(username: string, current: string, t: Messages["profile"]): string | null {
	if (username === current) return null;
	if (username === "") return t.usernameRequired;
	if (username.length < 3 || username.length > 32) return t.usernameLength;
	if (!USERNAME_PATTERN.test(username)) return t.usernameChars;
	return null;
}

type SaveResult = { kind: "saved" } | { kind: "error"; message: string } | null;

interface ProfileSettingsProps {
	self: SelfUser;
	onSelfChange: (self: SelfUser) => void;
}

export function ProfileSettings({ self, onSelfChange }: ProfileSettingsProps) {
	const api = useApi();
	const { t } = useI18n();
	const ids = useId();
	const [name, setName] = useState(self.name);
	const [username, setUsername] = useState(self.username);
	const [bio, setBio] = useState(self.bio);
	const [saving, setSaving] = useState(false);
	const [result, setResult] = useState<SaveResult>(null);
	// Server verdict on the username (taken or rejected); cleared on edit.
	const [usernameServerError, setUsernameServerError] = useState<string | null>(null);

	const trimmedName = name.trim();
	const nameError = trimmedName === "" ? t.profile.nameRequired : null;
	const usernameError = usernameProblem(username, self.username, t.profile) ?? usernameServerError;
	const dirty = trimmedName !== self.name || username !== self.username || bio !== self.bio;
	const canSave = dirty && !saving && nameError === null && usernameError === null;

	const reset = (to: SelfUser) => {
		setName(to.name);
		setUsername(to.username);
		setBio(to.bio);
		setUsernameServerError(null);
	};

	const save = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!canSave) return;
		setSaving(true);
		setResult(null);
		let latest = self;
		let step: "username" | "profile" = "username";
		try {
			if (username !== latest.username) {
				latest = await api.setUsername(username);
				onSelfChange(latest);
			}
			step = "profile";
			const changes: ProfileChanges = {};
			if (trimmedName !== latest.name) changes.name = trimmedName;
			if (bio !== latest.bio) changes.bio = bio;
			if (changes.name !== undefined || changes.bio !== undefined) {
				latest = await api.updateProfile(changes);
				onSelfChange(latest);
			}
			reset(latest);
			setResult({ kind: "saved" });
		} catch (err) {
			const code = errorCode(err);
			if (step === "username" && code === Code.AlreadyExists) {
				setUsernameServerError(t.profile.usernameTaken(username));
			} else if (step === "username" && code === Code.InvalidArgument) {
				setUsernameServerError(t.profile.usernameRejected);
			} else if (code === Code.InvalidArgument) {
				setResult({ kind: "error", message: t.profile.invalid });
			} else if (code !== Code.Unauthenticated) {
				setResult({ kind: "error", message: t.common.networkError });
			}
		} finally {
			setSaving(false);
		}
	};

	const nameId = `${ids}-name`;
	const usernameId = `${ids}-username`;
	const bioId = `${ids}-bio`;

	return (
		<form className="set-body" onSubmit={(event) => void save(event)} noValidate aria-busy={saving}>
			<div className="card pad photo-row">
				<Avatar name={self.name} size="xl" />
				<div>
					<b>{self.name}</b>
					{self.username && <span className="mono muted">@{self.username}</span>}
				</div>
			</div>

			<div className="card pad stack">
				<div className="field">
					<label htmlFor={nameId}>{t.profile.name}</label>
					<input
						id={nameId}
						className="input"
						value={name}
						maxLength={NAME_MAX}
						autoComplete="name"
						aria-invalid={nameError !== null}
						aria-describedby={nameError ? `${nameId}-error` : undefined}
						onChange={(event) => {
							setName(event.target.value);
							setResult(null);
						}}
					/>
					{nameError && (
						<span className="status bad" id={`${nameId}-error`}>
							<Icon name="alert" small />
							<span>{nameError}</span>
						</span>
					)}
				</div>

				<div className="field">
					<label htmlFor={usernameId}>{t.profile.username}</label>
					<div className={usernameError ? "affix invalid" : "affix"}>
						<span aria-hidden="true">@</span>
						<input
							id={usernameId}
							className="input"
							value={username}
							maxLength={32}
							autoComplete="off"
							autoCapitalize="off"
							spellCheck={false}
							aria-invalid={usernameError !== null}
							aria-describedby={`${usernameId}-status ${usernameId}-hint`}
							onChange={(event) => {
								setUsername(event.target.value);
								setUsernameServerError(null);
								setResult(null);
							}}
						/>
					</div>
					<span className="status bad" id={`${usernameId}-status`} aria-live="polite">
						{usernameError && (
							<>
								<Icon name="alert" small />
								<span>{usernameError}</span>
							</>
						)}
					</span>
					<span className="hint" id={`${usernameId}-hint`}>
						{t.profile.usernameHint}
					</span>
				</div>

				<div className="field">
					<label htmlFor={bioId}>{t.profile.bio}</label>
					<textarea
						id={bioId}
						className="input"
						value={bio}
						maxLength={BIO_MAX}
						rows={2}
						aria-describedby={`${bioId}-count`}
						onChange={(event) => {
							setBio(event.target.value);
							setResult(null);
						}}
					/>
					<span className="hint counter" id={`${bioId}-count`}>
						{bio.length}/{BIO_MAX}
					</span>
				</div>
			</div>

			<div className="card">
				<div className="row pad-x">
					<span className="device">
						<Icon name="lock" />
					</span>
					<span className="grow">
						{t.profile.email}
						<small className="mono">{self.email || t.profile.noEmail}</small>
					</span>
					<span className="tag-neutral">{t.profile.emailSource}</span>
				</div>
				<p className="note pad-x pad-b">
					{t.profile.emailNote}{" "}
					<ExternalLink className="link" href={brand.accountUrl}>
						{t.profile.changeSignIn}
					</ExternalLink>
				</p>
			</div>

			<div role="status">
				{result?.kind === "saved" && (
					<div className="banner ok">
						<Icon name="check" small />
						<span className="grow">{t.profile.saved}</span>
					</div>
				)}
			</div>
			{result?.kind === "error" && (
				<div className="banner error" role="alert">
					<Icon name="alert" small />
					<span className="grow">{result.message}</span>
				</div>
			)}

			<div className="save-bar">
				{dirty && <span className="muted">{t.profile.unsaved}</span>}
				<button type="button" className="btn" disabled={!dirty || saving} onClick={() => reset(self)}>
					{t.profile.cancel}
				</button>
				<button type="submit" className="btn btn-primary" disabled={!canSave} aria-busy={saving}>
					{saving && <span className="spin" aria-hidden="true" />}
					{saving ? t.profile.saving : t.profile.save}
				</button>
			</div>
		</form>
	);
}
