// Developer Console, Mini App tab (mockups/console.html#mini-app-settings):
// the bot's main Mini App URL with a preview of the header users see, and
// how the bot's server verifies initData. The server decides what it takes
// (https, not under the app's or a tenant's domain, no credentials, no IP
// host, 512 characters); the field checks what it can before saving.
import { useState, type FormEvent, type ReactNode } from "react";
import { Icon } from "../../components/icon.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { useServices } from "../data/services.tsx";
import { useDomId } from "../ui/parts.tsx";
import { botErrorKind, type OwnBot } from "./api.ts";
import { useBotsCopy } from "./use-bots-copy.ts";
import type { BotsCopy } from "./copy-vi.ts";

/** Longest Mini App URL the server takes (bot_admin.proto). */
const URL_MAX = 512;

export type MiniAppUrlProblem = keyof BotsCopy["miniApp"]["urlProblem"];

/** What is wrong with a Mini App URL before saving; null when it may go to the server ("" removes the Mini App). */
export function miniAppUrlProblem(value: string): MiniAppUrlProblem | null {
	if (value === "") return null;
	if (value.length > URL_MAX) return "long";
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return "invalid";
	}
	if (url.protocol !== "https:" || !url.hostname.includes(".")) return url.hostname.startsWith("[") ? "ip" : "invalid";
	if (url.username !== "" || url.password !== "") return "credentials";
	if (url.hash !== "" || value.includes("#")) return "fragment";
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname)) return "ip";
	return null;
}

/** The host a valid URL shows in the container's header; "" otherwise. */
function hostOf(value: string): string {
	try {
		return new URL(value).host;
	} catch {
		return "";
	}
}

/** Text and code in turn (copy lists them so: odd items are code). */
function Coded({ parts }: { parts: readonly string[] }) {
	const out: ReactNode[] = parts.map((part, index) =>
		index % 2 === 1 ? (
			<code key={index} className="mono">
				{part}
			</code>
		) : (
			part
		),
	);
	return <>{out}</>;
}

export function MiniAppTab({ bot, onSaved }: { bot: OwnBot; onSaved: (bot: OwnBot) => void }) {
	const t = useBotsCopy().miniApp;
	const copy = useCopy();
	const { bots, toasts } = useServices();
	const [url, setUrl] = useState(bot.miniAppUrl);
	const [saving, setSaving] = useState(false);
	const [serverError, setServerError] = useState("");
	const formId = useDomId("mini-app");
	const urlId = useDomId("ma-url");
	const value = url.trim();
	const problem = miniAppUrlProblem(value);
	const shown = problem === null ? serverError : t.urlProblem[problem];
	const dirty = value !== bot.miniAppUrl;
	const host = problem === null ? hostOf(value) : "";

	const save = async (event: FormEvent) => {
		event.preventDefault();
		if (!dirty || problem !== null || saving) return;
		setSaving(true);
		setServerError("");
		try {
			const saved = await bots.update(bot.id, { miniAppUrl: value });
			onSaved(saved);
			setUrl(saved.miniAppUrl);
			toasts.show(saved.miniAppUrl === "" ? t.removed : t.saved);
		} catch (err) {
			setServerError(botErrorKind(err) === "invalid" ? t.refused : copy.common.failed);
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="c-grid">
			<form className="card form" aria-labelledby={formId} onSubmit={(event) => void save(event)} noValidate>
				<h2 id={formId}>{t.title}</h2>
				<div className="field">
					<label htmlFor={urlId}>{t.url}</label>
					<input
						id={urlId}
						className="input mono"
						type="url"
						inputMode="url"
						value={url}
						maxLength={URL_MAX}
						placeholder="https://"
						autoComplete="off"
						autoCapitalize="off"
						spellCheck={false}
						aria-invalid={shown !== ""}
						aria-describedby={`${urlId}-msg`}
						onChange={(event) => {
							setUrl(event.target.value);
							setServerError("");
						}}
					/>
					<span id={`${urlId}-msg`} className={shown === "" ? "hint" : "error-text"} role={shown === "" ? undefined : "alert"}>
						{shown === "" ? t.urlHint : shown}
					</span>
				</div>
				<div className="field">
					<span className="label">{t.preview}</span>
					{host === "" ? (
						<p className="note">{t.previewNone}</p>
					) : (
						<div className="ma-preview" data-testid="mini-app-preview">
							<div className="bar">
								<div>
									<strong>{bot.name}</strong>
									<span>
										<Icon name="lock" small />
										{host}
									</span>
								</div>
								<Icon name="x" />
							</div>
							<div className="body">
								{t.previewBody} <span className="mono">{value}</span>
							</div>
						</div>
					)}
				</div>
				<div className="card-foot">
					<button type="submit" className="btn btn-primary" disabled={!dirty || problem !== null || saving} aria-busy={saving}>
						{saving ? t.saving : t.save}
					</button>
				</div>
			</form>
			<div className="card side-card">
				<h2>{t.verifyTitle}</h2>
				<ul>
					{t.verify.map((parts) => (
						<li key={parts[0]}>
							<Coded parts={parts} />
						</li>
					))}
					<li>
						<Coded parts={t.script(`${window.location.origin}/miniapp/sdk.js`)} />
					</li>
				</ul>
				<div className="sdk-list">
					{t.sdks.map((sdk) => (
						<div key={sdk.name}>
							<b>{sdk.name}</b>
							<span>{sdk.note}</span>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
