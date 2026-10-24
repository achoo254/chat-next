// Developer Console (mockups/console.html), opened from Settings on the chat
// session: the caller's bots, a new bot, and one bot's profile, token,
// commands and Mini App (mini-app-settings.tsx). A token is shown once,
// right after it is issued; issuing one, deleting a bot or setting its
// webhook needs a recent sign-in, so the
// console sends the browser to /auth/login?reauth=1 and, back on the same
// page, asks once more (`?after=token`, `?after=delete` or `?after=webhook`
// opens the confirmation; only its button acts, so a link carrying the
// parameter cannot issue a token by itself). The delivery tabs (Nhận update,
// Update lỗi, Số liệu) live in delivery.tsx, the shared dialogs in
// dialogs.tsx.
// Loaded on demand with its own styles.
import { useEffect, useState, type FormEvent } from "react";
import { fold } from "@achoo254/chat-core";
import { useLoader } from "../../components/delayed-loader.tsx";
import { useLoad, type Load } from "../../components/preload.ts";
import { Icon } from "../../components/screen-icons.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { Link, navigate, paths, useSearch, type ConsolePage, type ConsoleTab } from "../../router.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { orgDomain } from "../data/format.ts";
import { myBotsData } from "../data/screen-data.ts";
import { useServices } from "../data/services.tsx";
import { ChatAvatar, copyText, Switch, useDomId } from "../ui/parts.tsx";
import { BOT_LIMITS, botErrorKind, EDITABLE_SCOPES, usernameProblem, validCommand, type BotCommand, type CommandScope, type CommandSets, type OwnBot } from "./api.ts";
import { DeadLettersTab, StatsTab, UpdatesTab, when } from "./delivery.tsx";
import { ConfirmDialog, ReauthDialog, reauthUrl, useConfirmShown, type After, type TabProps } from "./dialogs.tsx";
import { BotPhotoField } from "./bot-photo.tsx";
import { MiniAppTab } from "./mini-app-settings.tsx";
import { useBotsCopy } from "./use-bots-copy.ts";
import type { BotsCopy } from "./copy-vi.ts";
import "./console.css";
import { serverHost, serverOrigin } from "../../server-origin.ts";

/** An owner has at most this many bots (bot_admin.proto). */
const BOTS_MAX = 20;
const USERNAME_CHECK_DELAY_MS = 400;

/**
 * The caller's bots for the list (`page` 0) or a bot's page, with a way to
 * reload and to apply a changed bot locally. The first list comes through Suspense, started by the route with the
 * console's code (messaging-root.tsx), so the page shows once.
 */
function useMyBots(page: number): [Load<OwnBot[]>, () => void, (bot: OwnBot) => void] {
	const { bots } = useServices();
	const [state, reload, update] = useLoad(myBotsData(bots, page));
	const put = (bot: OwnBot) => update((value) => value.map((b) => (b.id === bot.id ? bot : b)));
	return [state, reload, put];
}

/** The Bot API base of this tenant. */
function apiBase(): string {
	return `${serverOrigin()}/bot/v1`;
}

export default function DeveloperConsole({ view }: { view: ConsolePage }) {
	switch (view.page) {
		case "list":
			return <BotList />;
		case "new":
			return <CreateBot />;
		case "bot":
			return <BotPage key={view.botId} botId={view.botId} tab={view.tab} />;
	}
}

function ConsoleHead({ back, backLabel, parent, current }: { back: string; backLabel: string; parent: string; current: string }) {
	const { self } = useServices();
	return (
		<header className="c-head">
			<Link to={back} className="icon-btn" aria-label={backLabel}>
				<Icon name="back" />
			</Link>
			<span className="crumbs">
				<span>{parent}</span>
				<Icon name="chevron-right" small />
				<b>{current}</b>
			</span>
			<span className="who-chip">
				<ChatAvatar id={self.id} name={self.name} photoOf={self.id} photoId={self.photoId} size="sm" />
				<span>
					{self.name} · {orgDomain(serverHost())}
				</span>
			</span>
		</header>
	);
}

function LoadError({ onRetry }: { onRetry: () => void }) {
	const copy = useCopy();
	return (
		<div className="banner error" role="alert">
			<Icon name="alert" small />
			<span className="grow">{copy.common.loadFailed}</span>
			<button type="button" className="btn btn-sm" onClick={onRetry}>
				{copy.common.retry}
			</button>
		</div>
	);
}

// ------------------------------------------------------------------ list

function BotList() {
	const t = useBotsCopy();
	const { locale } = useI18n();
	const copy = useCopy();
	const [state, reload] = useMyBots(0);
	const loader = useLoader(state.status === "loading", copy.common.loading);
	const org = orgDomain(serverHost());
	const titleId = useDomId("bots");
	const bots = state.status === "ready" ? state.value : [];
	const full = bots.length >= BOTS_MAX;
	return (
		<section className="console" aria-labelledby={titleId}>
			<ConsoleHead back={paths.settingsList} backLabel={t.console.backToSettings} parent={t.console.settings} current={t.console.title} />
			<div className="c-body">
				<div className="c-title">
					<h1 id={titleId}>{t.console.myBots}</h1>
					{state.status === "ready" && bots.length > 0 && !full && (
						<Link to={paths.consoleNew()} className="btn btn-primary">
							<Icon name="plus" />
							{t.console.create}
						</Link>
					)}
				</div>
				{full && <p className="note">{t.console.limitReached(BOTS_MAX)}</p>}
				{loader ?? (state.status === "error" ? (
					<LoadError onRetry={reload} />
				) : bots.length === 0 ? (
					<div className="card pad">
						<div className="empty">
							<Icon name="robot" />
							<strong>{t.console.emptyTitle}</strong>
							<span>{t.console.emptyBody(org)}</span>
							<Link to={paths.consoleNew()} className="btn btn-primary">
								<Icon name="plus" />
								{t.console.createFirst}
							</Link>
						</div>
					</div>
				) : (
					<div className="card table-card">
						<table className="data">
							<thead>
								<tr>
									<th>{t.console.columns.bot}</th>
									<th>{t.console.columns.updates}</th>
									<th>{t.console.columns.token}</th>
									<th>
										<span className="sr-only">{t.console.columns.actions}</span>
									</th>
								</tr>
							</thead>
							<tbody>
								{bots.map((bot) => (
									<tr key={bot.id}>
										<td>
											<span className="bot-cell">
												<ChatAvatar id={bot.id} name={bot.name} size="sm" bot photoOf={bot.id} photoId={bot.photoId} />
												<span>
													<strong>{bot.name}</strong>
													<span className="cell-sub mono">@{bot.username}</span>
												</span>
											</span>
										</td>
										<td data-label={t.console.columns.updates}>{bot.webhook ? t.console.webhook : t.console.longPoll}</td>
										<td data-label={t.console.columns.token}>
											{bot.hasToken ? t.console.tokenIssued(when(bot.tokenIssuedAt, locale)) : <span className="muted">{t.console.noToken}</span>}
										</td>
										<td className="actions-cell">
											<Link to={paths.consoleBot(bot.id)} className="btn btn-sm" aria-label={t.console.manageName(bot.name)}>
												{t.console.manage}
											</Link>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				))}
			</div>
		</section>
	);
}

// ---------------------------------------------------------------- create

type UsernameCheck = "idle" | "checking" | "ok" | "taken";

/**
 * What may go in a username, applied as it is typed: Vietnamese folded to
 * plain letters (đ to d), lower case, spaces and dashes to "_", anything else
 * dropped.
 */
export function normalizeUsername(text: string): string {
	return fold(text.replace(/[\s-]+/gu, "_"))
		.replace(/[^a-z0-9_]/g, "")
		.slice(0, BOT_LIMITS.usernameMax);
}

/** The username offered for a display name: "Deploy Thử" to "deploy_thu_bot"; empty when the name has no usable letters. */
export function usernameFromName(name: string): string {
	const stem = normalizeUsername(name).replace(/_+/g, "_").replace(/^_|_$/g, "");
	if (stem === "") return "";
	if (stem.endsWith("bot")) return stem;
	return `${stem.slice(0, BOT_LIMITS.usernameMax - "_bot".length).replace(/_$/, "")}_bot`;
}

/** Two other usernames to try when one is taken: same stem, still ending in "bot". */
export function usernameSuggestions(username: string): string[] {
	const stem = username.replace(/_?bot$/, "").replace(/_+$/, "") || "my";
	return [`${stem}_team_bot`, `${stem}2_bot`]
		.map((candidate) => (candidate.length > BOT_LIMITS.usernameMax ? `${stem.slice(0, BOT_LIMITS.usernameMax - 9)}_team_bot` : candidate))
		.filter((candidate) => usernameProblem(candidate) === null && candidate !== username);
}

function CreateBot() {
	const t = useBotsCopy();
	const copy = useCopy();
	const { bots, toasts } = useServices();
	const [name, setName] = useState("");
	const [username, setUsername] = useState("");
	// Until the username is typed in, it follows the display name.
	const [usernameEdited, setUsernameEdited] = useState(false);
	const [description, setDescription] = useState("");
	const [privacy, setPrivacy] = useState(true);
	const [inline, setInline] = useState({ on: false, placeholder: "" });
	const [check, setCheck] = useState<UsernameCheck>("idle");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [touched, setTouched] = useState(false);
	const org = orgDomain(serverHost());
	const nameId = useDomId("cb-name");
	const userId = useDomId("cb-user");
	const descId = useDomId("cb-desc");
	const formId = useDomId("cb-form");

	const problem = username === "" ? null : usernameProblem(username);

	useEffect(() => {
		if (username === "" || problem !== null) return;
		let active = true;
		const timer = setTimeout(() => {
			setCheck("checking");
			bots.usernameTaken(username).then(
				(taken) => {
					if (active) setCheck(taken ? "taken" : "ok");
				},
				() => {
					// Unknown: the server checks again on create.
					if (active) setCheck("idle");
				},
			);
		}, USERNAME_CHECK_DELAY_MS);
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [bots, username, problem]);

	const usernameError = problem !== null ? t.create.usernameProblem[problem] : check === "taken" ? t.create.usernameProblem.taken : "";
	const nameError = touched && name.trim() === "" ? t.create.nameRequired : "";
	const canSubmit = !busy && name.trim() !== "" && username !== "" && usernameError === "" && !(inline.on && inline.placeholder.trim() === "");

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setTouched(true);
		if (!canSubmit) return;
		setBusy(true);
		setError("");
		try {
			let bot = await bots.create(username, name.trim());
			const inlinePlaceholder = inline.on ? inline.placeholder.trim() : "";
			if (description.trim() !== "" || !privacy || inlinePlaceholder !== "") {
				bot = await bots.update(bot.id, { description: description.trim(), privacy, inlinePlaceholder });
			}
			toasts.show(t.create.created);
			navigate(paths.consoleBot(bot.id, "token"));
		} catch (err) {
			setBusy(false);
			const kind = botErrorKind(err);
			if (kind === "username_taken") setCheck("taken");
			else setError(kind === "bots_limit" ? t.console.limitReached(BOTS_MAX) : kind === "rate_limited" ? t.create.rateLimited : copy.common.failed);
		}
	};

	const hint = usernameError !== "" ? null : check === "checking" ? t.create.checking : check === "ok" ? t.create.usernameOk : null;
	return (
		<section className="console" aria-labelledby={formId}>
			<ConsoleHead back={paths.console()} backLabel={t.console.backToList} parent={t.console.title} current={t.console.create} />
			<div className="c-body">
				<div className="c-grid">
					<form className="card form" aria-labelledby={formId} onSubmit={(event) => void submit(event)} noValidate>
						<h2 id={formId}>{t.create.title}</h2>
						<div className="field">
							<label htmlFor={nameId}>{t.create.name}</label>
							<input
								id={nameId}
								className="input"
								value={name}
								maxLength={BOT_LIMITS.name}
								autoComplete="off"
								aria-invalid={nameError !== ""}
								onChange={(event) => {
									setName(event.target.value);
									if (!usernameEdited) {
										setUsername(usernameFromName(event.target.value));
										setCheck("idle");
									}
								}}
								onBlur={() => setTouched(true)}
							/>
							{nameError !== "" && <span className="error-text">{nameError}</span>}
						</div>
						<div className="field">
							<label htmlFor={userId}>{t.create.username}</label>
							<div className={usernameError === "" ? "affix" : "affix invalid"}>
								<span aria-hidden="true">@</span>
								<input
									id={userId}
									className="input"
									value={username}
									maxLength={BOT_LIMITS.usernameMax}
									autoComplete="off"
									autoCapitalize="off"
									spellCheck={false}
									aria-invalid={usernameError !== ""}
									aria-describedby={`${userId}-msg ${userId}-hint`}
									onChange={(event) => {
										setUsername(normalizeUsername(event.target.value));
										setUsernameEdited(true);
										setCheck("idle");
									}}
								/>
							</div>
							<span id={`${userId}-msg`} role="status" className={usernameError !== "" ? "error-text" : "hint-ok"}>
								{usernameError !== "" ? usernameError : (hint ?? "")}
							</span>
							{check === "taken" && (
								<div className="suggest">
									{t.create.suggest}
									{usernameSuggestions(username).map((candidate) => (
										<button
											key={candidate}
											type="button"
											className="btn btn-sm mono"
											onClick={() => {
												setUsername(candidate);
												setUsernameEdited(true);
												setCheck("idle");
											}}
										>
											{candidate}
										</button>
									))}
								</div>
							)}
							<span className="hint" id={`${userId}-hint`}>
								{t.create.usernameHint}
							</span>
						</div>
						<div className="field">
							<label htmlFor={descId}>{t.create.description}</label>
							<textarea
								id={descId}
								className="input"
								rows={3}
								value={description}
								maxLength={BOT_LIMITS.description}
								onChange={(event) => setDescription(event.target.value)}
							/>
							<span className="hint">{t.create.descriptionHint}</span>
						</div>
						<div className="setting">
							<div>
								<strong>{t.create.privacy}</strong>
								<small>{t.create.privacyHint}</small>
							</div>
							<Switch checked={privacy} label={t.create.privacy} onChange={setPrivacy} />
						</div>
						<InlineSetting value={inline} onChange={setInline} />
						{error !== "" && (
							<div className="banner error" role="alert">
								<Icon name="alert" small />
								<span className="grow">{error}</span>
							</div>
						)}
						<div className="card-foot">
							<Link to={paths.console()} className="btn">
								{copy.common.cancel}
							</Link>
							<button type="submit" className="btn btn-primary" disabled={!canSubmit} aria-busy={busy}>
								{busy ? t.create.creating : t.create.submit}
							</button>
						</div>
					</form>
					<div className="card side-card">
						<h2>{t.create.orgTitle(org)}</h2>
						<ul>
							{t.create.rules(org, apiBase()).map((rule) => (
								<li key={rule}>{rule}</li>
							))}
						</ul>
					</div>
				</div>
			</div>
		</section>
	);
}

// ------------------------------------------------------------- one bot

/** The `?after=` of `search` when it belongs to `tab` (token on Token, delete on Hồ sơ, webhook on Nhận update); null otherwise. */
function afterOf(search: string, tab: ConsoleTab): After | null {
	const after = new URLSearchParams(search).get("after");
	if (after === "token" && tab === "token") return "token";
	if (after === "delete" && tab === "profile") return "delete";
	if (after === "webhook" && tab === "updates") return "webhook";
	return null;
}

function BotPage({ botId, tab }: { botId: number; tab: ConsoleTab }) {
	const t = useBotsCopy();
	const copy = useCopy();
	const [state, reload, put] = useMyBots(botId);
	const loader = useLoader(state.status === "loading", copy.common.loading);
	// ?after= is taken once per navigation: the tab opens its confirmation
	// (remounted for a new one) and marks it shown, and the parameter leaves
	// the URL, so neither a tab switch nor a reload asks again.
	const search = useSearch();
	const [taken, setTaken] = useState(() => ({ search, after: afterOf(search, tab), round: 0 }));
	if (search !== taken.search) {
		const next = afterOf(search, tab);
		setTaken(next === null ? { ...taken, search } : { search, after: next, round: taken.round + 1 });
	}
	useEffect(() => {
		if (new URLSearchParams(search).has("after")) navigate(window.location.pathname, { replace: true });
	}, [search]);
	const shown = () => setTaken((current) => (current.after === null ? current : { ...current, after: null }));
	const bot = state.status === "ready" ? (state.value.find((b) => b.id === botId) ?? null) : null;
	const titleId = useDomId("bot");
	const TABS: readonly ConsoleTab[] = ["profile", "token", "updates", "dead-letters", "stats", "commands", "mini-app"];
	return (
		<section className="console" aria-labelledby={titleId}>
			<ConsoleHead back={paths.console()} backLabel={t.console.backToList} parent={t.console.title} current={bot?.name ?? t.console.myBots} />
			{loader !== null || state.status !== "ready" ? (
				<div className="c-body">{loader ?? <LoadError onRetry={reload} />}</div>
			) : bot === null ? (
				<div className="c-body">
					<div className="empty">
						<Icon name="robot" />
						<strong>{t.console.notFound}</strong>
						<Link to={paths.console()} className="btn">
							{t.console.backToList}
						</Link>
					</div>
				</div>
			) : (
				<>
					<div className="c-bot">
						<ChatAvatar id={bot.id} name={bot.name} size="sm" bot photoOf={bot.id} photoId={bot.photoId} />
						<div>
							<h1 id={titleId}>{bot.name}</h1>
							<small className="mono">@{bot.username}</small>
						</div>
					</div>
					<nav className="c-tabs" aria-label={t.console.tabs}>
						{TABS.map((item) => (
							<Link key={item} to={paths.consoleBot(bot.id, item)} current={item === tab}>
								{t.console.tab[item]}
							</Link>
						))}
					</nav>
					<div className="c-body">
						{tab === "profile" ? (
							<ProfileTab key={taken.round} bot={bot} onSaved={put} confirmNow={taken.after === "delete"} onConfirmShown={shown} />
						) : tab === "token" ? (
							<TokenTab key={taken.round} bot={bot} onIssued={put} confirmNow={taken.after === "token"} onConfirmShown={shown} />
						) : tab === "updates" ? (
							<UpdatesTab key={taken.round} bot={bot} onChanged={put} confirmNow={taken.after === "webhook"} onConfirmShown={shown} />
						) : tab === "dead-letters" ? (
							<DeadLettersTab bot={bot} />
						) : tab === "stats" ? (
							<StatsTab bot={bot} />
						) : tab === "commands" ? (
							<CommandsTab bot={bot} onSaved={put} />
						) : (
							<MiniAppTab bot={bot} onSaved={put} />
						)}
					</div>
				</>
			)}
		</section>
	);
}

// ---------------------------------------------------------------- profile


interface InlineValue {
	readonly on: boolean;
	readonly placeholder: string;
}

/** The hint to save: "" turns inline mode off. */
function inlineValue(value: InlineValue): string {
	return value.on ? value.placeholder.trim() : "";
}

/** Inline mode: on with a composer hint (required), off without. */
function InlineSetting({ value, onChange }: { value: InlineValue; onChange: (value: InlineValue) => void }) {
	const t = useBotsCopy();
	const id = useDomId("inline-ph");
	const missing = value.on && value.placeholder.trim() === "";
	return (
		<>
			<div className="setting">
				<div>
					<strong>{t.create.inline}</strong>
					<small>{t.create.inlineHint}</small>
				</div>
				<Switch checked={value.on} label={t.create.inline} onChange={(on) => onChange({ ...value, on })} />
			</div>
			{value.on && (
				<div className="field">
					<label htmlFor={id}>{t.create.inlinePlaceholder}</label>
					<input
						id={id}
						className="input"
						value={value.placeholder}
						maxLength={BOT_LIMITS.inlinePlaceholder}
						aria-invalid={missing}
						onChange={(event) => onChange({ ...value, placeholder: event.target.value })}
					/>
					<span className={missing ? "error-text" : "hint"}>{missing ? t.create.inlinePlaceholderRequired : t.create.inlinePlaceholderHint}</span>
				</div>
			)}
		</>
	);
}
function ProfileTab({ bot, onSaved, confirmNow, onConfirmShown }: TabProps & { onSaved: (bot: OwnBot) => void }) {
	const t = useBotsCopy();
	const copy = useCopy();
	const { locale } = useI18n();
	const { bots, toasts } = useServices();
	const [name, setName] = useState(bot.name);
	const [description, setDescription] = useState(bot.description);
	const [about, setAbout] = useState(bot.about);
	const [privacy, setPrivacy] = useState(bot.privacy);
	const [inline, setInline] = useState({ on: bot.inlinePlaceholder !== "", placeholder: bot.inlinePlaceholder });
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const [dialog, setDialog] = useState<"confirm" | "reauth" | null>(confirmNow ? "confirm" : null);
	useConfirmShown(confirmNow, onConfirmShown);
	const [deleting, setDeleting] = useState(false);
	const formId = useDomId("profile");
	const nameId = useDomId("pf-name");
	const descId = useDomId("pf-desc");
	const aboutId = useDomId("pf-about");
	const userId = useDomId("pf-user");

	const changes = {
		...(name.trim() !== bot.name ? { name: name.trim() } : {}),
		...(description.trim() !== bot.description ? { description: description.trim() } : {}),
		...(about.trim() !== bot.about ? { about: about.trim() } : {}),
		...(privacy !== bot.privacy ? { privacy } : {}),
		...(inlineValue(inline) !== bot.inlinePlaceholder ? { inlinePlaceholder: inlineValue(inline) } : {}),
	};
	const dirty = Object.keys(changes).length > 0;
	const nameError = name.trim() === "" ? t.create.nameRequired : "";
	const inlineError = inline.on && inline.placeholder.trim() === "";

	const save = async (event: FormEvent) => {
		event.preventDefault();
		if (!dirty || nameError !== "" || inlineError || saving) return;
		setSaving(true);
		setError("");
		try {
			const saved = await bots.update(bot.id, changes);
			onSaved(saved);
			toasts.show(t.profile.saved);
		} catch {
			setError(copy.common.failed);
		} finally {
			setSaving(false);
		}
	};

	const remove = async () => {
		setDeleting(true);
		try {
			await bots.remove(bot.id);
			toasts.show(t.profile.deleted(bot.name));
			navigate(paths.console());
		} catch (err) {
			setDeleting(false);
			if (botErrorKind(err) === "reauth_required") setDialog("reauth");
			else {
				setDialog(null);
				toasts.show(copy.common.failed);
			}
		}
	};

	return (
		<div className="c-grid">
			<form className="card form" aria-labelledby={formId} onSubmit={(event) => void save(event)} noValidate>
				<h2 id={formId}>{t.profile.title}</h2>
				<BotPhotoField bot={bot} onSaved={onSaved} />
				<div className="field">
					<label htmlFor={nameId}>{t.create.name}</label>
					<input
						id={nameId}
						className="input"
						value={name}
						maxLength={BOT_LIMITS.name}
						autoComplete="off"
						aria-invalid={nameError !== ""}
						onChange={(event) => setName(event.target.value)}
					/>
					{nameError !== "" && <span className="error-text">{nameError}</span>}
				</div>
				<div className="field">
					<span className="label" id={userId}>
						{t.create.username}
					</span>
					<span className="mono" aria-labelledby={userId}>
						@{bot.username}
					</span>
					<span className="hint">{t.profile.usernameFixed}</span>
				</div>
				<div className="field">
					<label htmlFor={descId}>{t.create.description}</label>
					<textarea
						id={descId}
						className="input"
						rows={3}
						value={description}
						maxLength={BOT_LIMITS.description}
						onChange={(event) => setDescription(event.target.value)}
					/>
					<span className="hint">{t.create.descriptionHint}</span>
				</div>
				<div className="field">
					<label htmlFor={aboutId}>{t.profile.about}</label>
					<input id={aboutId} className="input" value={about} maxLength={BOT_LIMITS.about} onChange={(event) => setAbout(event.target.value)} />
					<span className="hint">{t.profile.aboutHint}</span>
				</div>
				<div className="setting">
					<div>
						<strong>{t.create.privacy}</strong>
						<small>{t.create.privacyHint}</small>
					</div>
					<Switch checked={privacy} label={t.create.privacy} onChange={setPrivacy} />
				</div>
				<InlineSetting value={inline} onChange={setInline} />
				{error !== "" && (
					<div className="banner error" role="alert">
						<Icon name="alert" small />
						<span className="grow">{error}</span>
					</div>
				)}
				<div className="card-foot">
					<button type="submit" className="btn btn-primary" disabled={!dirty || nameError !== "" || inlineError || saving} aria-busy={saving}>
						{saving ? t.profile.saving : t.profile.save}
					</button>
				</div>
			</form>
			<div className="card side-card">
				<h2>{t.profile.deleteTitle}</h2>
				<p>{t.profile.deleteBody}</p>
				<div className="card-foot">
					<button type="button" className="btn btn-danger" onClick={() => setDialog("confirm")}>
						<Icon name="trash" small />
						{t.profile.deleteAction}
					</button>
				</div>
			</div>
			{dialog === "confirm" && (
				<ConfirmDialog
					title={t.profile.confirmTitle(bot.name)}
					body={<p className="dlg-lede">{t.profile.confirmBody(bot.name)}</p>}
					action={t.profile.deleteAction}
					busyLabel={t.profile.deleting}
					busy={deleting}
					danger
					onConfirm={() => void remove()}
					onClose={() => setDialog(null)}
				/>
			)}
			{dialog === "reauth" && (
				<ReauthDialog body={t.reauth.bodyDelete} warning="" href={reauthUrl(locale, bot.id, "profile", "delete")} onClose={() => setDialog(null)} />
			)}
		</div>
	);
}

// ------------------------------------------------------------------ token

function TokenTab({ bot, onIssued, confirmNow, onConfirmShown }: TabProps & { onIssued: (bot: OwnBot) => void }) {
	const t = useBotsCopy();
	const copy = useCopy();
	const { locale } = useI18n();
	const { bots, toasts } = useServices();
	const [token, setToken] = useState("");
	const [busy, setBusy] = useState(false);
	// Back from the reauth sign-in: the user asks once more with the confirmation's button.
	const [dialog, setDialog] = useState<"confirm" | "reauth" | null>(confirmNow ? "confirm" : null);
	useConfirmShown(confirmNow, onConfirmShown);
	const titleId = useDomId("token");

	const issue = async () => {
		setBusy(true);
		try {
			const result = await bots.resetToken(bot.id);
			onIssued(result.bot);
			setToken(result.token);
			setDialog(null);
			toasts.show(t.token.issued);
		} catch (err) {
			if (botErrorKind(err) === "reauth_required") setDialog("reauth");
			else {
				setDialog(null);
				toasts.show(copy.common.failed);
			}
		} finally {
			setBusy(false);
		}
	};

	const masked = `${bot.id}:${"•".repeat(24)}`;
	return (
		<div className="c-grid">
			<div className="card form" role="group" aria-labelledby={titleId}>
				<h2 id={titleId}>{t.token.title}</h2>
				{token !== "" ? (
					<>
						<div className="banner warn">
							<Icon name="alert" small />
							<span className="grow">{t.token.onceWarning}</span>
						</div>
						<div className="secret">
							<code data-testid="bot-token">{token}</code>
							<button
								type="button"
								className="btn btn-sm"
								onClick={() => {
									void copyText(token).then((ok) => toasts.show(ok ? t.token.copied : copy.common.failed));
								}}
							>
								<Icon name="copy" small />
								{t.token.copy}
							</button>
						</div>
						<p className="note">{t.token.hashNote}</p>
						<div className="card-foot">
							<button
								type="button"
								className="btn btn-primary"
								onClick={() => {
									setToken("");
									toasts.show(t.token.hidden);
								}}
							>
								{t.token.savedIt}
							</button>
						</div>
					</>
				) : bot.hasToken ? (
					<>
						<div className="secret">
							<code aria-label={t.token.title}>{masked}</code>
						</div>
						<p className="note">{t.token.issuedAt(when(bot.tokenIssuedAt, locale))}</p>
						<div className="card-foot">
							<button type="button" className="btn btn-danger" disabled={busy} onClick={() => setDialog("confirm")}>
								{t.token.reissue}
							</button>
						</div>
					</>
				) : (
					<>
						<p className="note">{t.token.none}</p>
						<div className="card-foot">
							<button type="button" className="btn btn-primary" disabled={busy} aria-busy={busy} onClick={() => void issue()}>
								{busy ? t.token.issuing : t.token.issue}
							</button>
						</div>
					</>
				)}
			</div>
			<div className="card side-card">
				<h2>{t.token.pollTitle}</h2>
				{bot.webhook ? (
					<>
						<p>{t.token.webhookNote}</p>
						<div>
							<Link to={paths.consoleBot(bot.id, "updates")} className="btn btn-sm">
								{t.token.deliverySettings}
							</Link>
						</div>
					</>
				) : (
					<>
						<p>{t.token.pollNote}</p>
						<p>{bot.lastUpdateAt > 0 ? t.token.lastUpdate(when(bot.lastUpdateAt, locale)) : t.token.neverUpdated}</p>
						<div>
							<Link to={paths.consoleBot(bot.id, "updates")} className="btn btn-sm">
								{t.token.howToReceive}
							</Link>
						</div>
					</>
				)}
			</div>
			{dialog === "confirm" &&
				(bot.hasToken ? (
					<ConfirmDialog
						title={t.token.confirmTitle}
						body={
							<div className="banner warn">
								<Icon name="alert" small />
								<span className="grow">{t.token.confirmBody(bot.name, bot.webhook)}</span>
							</div>
						}
						action={t.token.reissue}
						busyLabel={t.token.issuing}
						busy={busy}
						danger
						onConfirm={() => void issue()}
						onClose={() => setDialog(null)}
					/>
				) : (
					<ConfirmDialog
						title={t.token.issueTitle(bot.name)}
						body={<p className="dlg-lede">{t.token.issueBody}</p>}
						action={t.token.issue}
						busyLabel={t.token.issuing}
						busy={busy}
						danger={false}
						onConfirm={() => void issue()}
						onClose={() => setDialog(null)}
					/>
				))}
			{dialog === "reauth" && (
				<ReauthDialog
					body={t.reauth.bodyToken}
					warning={bot.hasToken ? t.reauth.tokenWarning(bot.name) : ""}
					href={reauthUrl(locale, bot.id, "token", "token")}
					onClose={() => setDialog(null)}
				/>
			)}
		</div>
	);
}

// --------------------------------------------------------------- commands

interface CommandRow {
	readonly key: number;
	readonly command: string;
	readonly description: string;
}

type Editable = Exclude<CommandScope, "default">;
type Drafts = Readonly<Record<Editable, readonly CommandRow[]>>;

let nextRowKey = 1;

function rowsOf(commands: readonly BotCommand[] | undefined): CommandRow[] {
	return (commands ?? []).map((c) => ({ key: nextRowKey++, command: c.command, description: c.description }));
}

/** What is wrong with a command row; "" when it can be saved. */
export function commandProblem(row: CommandRow, rows: readonly CommandRow[], t: BotsCopy): { command: string; description: string } {
	const command = row.command.trim();
	let commandError = "";
	if (!validCommand(command)) commandError = t.commands.badCommand;
	else if (rows.some((other) => other.key !== row.key && other.command.trim() === command && other.key < row.key)) commandError = t.commands.duplicate;
	const description = row.description.trim();
	const descriptionError = description === "" || [...description].length > BOT_LIMITS.commandDescription ? t.commands.descriptionRequired : "";
	return { command: commandError, description: descriptionError };
}

function CommandsTab({ bot, onSaved }: { bot: OwnBot; onSaved: (bot: OwnBot) => void }) {
	const t = useBotsCopy();
	const copy = useCopy();
	const { bots, toasts } = useServices();
	const [scope, setScope] = useState<Editable>("private");
	const [drafts, setDrafts] = useState<Drafts>(() => ({
		private: rowsOf(bot.commands.private),
		group: rowsOf(bot.commands.group),
		group_admin: rowsOf(bot.commands.group_admin),
	}));
	const [saving, setSaving] = useState(false);
	const [showErrors, setShowErrors] = useState(false);
	const [error, setError] = useState("");
	const formId = useDomId("cmds");
	const rows = drafts[scope];

	const setRows = (next: readonly CommandRow[]) => setDrafts((current) => ({ ...current, [scope]: next }));
	const edit = (key: number, change: Partial<Pick<CommandRow, "command" | "description">>) =>
		setRows(rows.map((row) => (row.key === key ? { ...row, ...change } : row)));

	const invalid = (EDITABLE_SCOPES as readonly Editable[]).some((s) =>
		drafts[s].some((row) => {
			const problem = commandProblem(row, drafts[s], t);
			return problem.command !== "" || problem.description !== "";
		}),
	);

	const save = async (event: FormEvent) => {
		event.preventDefault();
		if (saving) return;
		if (invalid) {
			setShowErrors(true);
			setError(t.commands.fixFirst);
			return;
		}
		setSaving(true);
		setError("");
		// The default scope is kept as the bot set it through the API.
		const sets: Partial<Record<CommandScope, readonly BotCommand[]>> = { ...(bot.commands.default === undefined ? {} : { default: bot.commands.default }) };
		for (const s of EDITABLE_SCOPES as readonly Editable[]) {
			sets[s] = drafts[s].map((row) => ({ command: row.command.trim(), description: row.description.trim() }));
		}
		try {
			const saved = await bots.update(bot.id, { commands: sets as CommandSets });
			onSaved(saved);
			toasts.show(t.commands.saved);
		} catch {
			setError(copy.common.failed);
		} finally {
			setSaving(false);
		}
	};

	const valid = rows.filter((row) => validCommand(row.command.trim()) && row.description.trim() !== "");
	return (
		<div className="c-grid">
			<form className="card form" aria-labelledby={formId} onSubmit={(event) => void save(event)} noValidate>
				<h2 id={formId} className="sr-only">
					{t.console.tab.commands}
				</h2>
				<div className="scope-tabs" role="tablist" aria-label={t.commands.scopesLabel}>
					{(EDITABLE_SCOPES as readonly Editable[]).map((s) => (
						<button key={s} type="button" role="tab" aria-selected={s === scope} onClick={() => setScope(s)}>
							{t.commands.scope[s]}
						</button>
					))}
				</div>
				<div className="cmd-rows" role="tabpanel" aria-label={t.commands.scope[scope]}>
					{rows.map((row) => {
						const problem = commandProblem(row, rows, t);
						const commandError = showErrors || row.command !== "" ? problem.command : "";
						const descriptionError = showErrors ? problem.description : "";
						return (
							<div className="cmd-row" key={row.key}>
								<div className="field">
									<div className={commandError === "" ? "affix" : "affix invalid"}>
										<span aria-hidden="true">/</span>
										<input
											className="input"
											value={row.command}
											aria-label={t.commands.command}
											aria-invalid={commandError !== ""}
											placeholder={t.commands.commandPlaceholder}
											maxLength={32}
											autoCapitalize="off"
											spellCheck={false}
											onChange={(event) => edit(row.key, { command: event.target.value })}
										/>
									</div>
									{commandError !== "" && <span className="error-text">{commandError}</span>}
								</div>
								<div className="field">
									<input
										className="input"
										value={row.description}
										aria-label={t.commands.description}
										aria-invalid={descriptionError !== ""}
										placeholder={t.commands.descriptionPlaceholder}
										maxLength={BOT_LIMITS.commandDescription}
										onChange={(event) => edit(row.key, { description: event.target.value })}
									/>
									{descriptionError !== "" && <span className="error-text">{descriptionError}</span>}
								</div>
								<button type="button" className="icon-btn" aria-label={t.commands.remove} onClick={() => setRows(rows.filter((r) => r.key !== row.key))}>
									<Icon name="trash" />
								</button>
							</div>
						);
					})}
				</div>
				<div>
					<button
						type="button"
						className="btn btn-sm"
						disabled={rows.length >= BOT_LIMITS.commandsPerScope}
						onClick={() => setRows([...rows, { key: nextRowKey++, command: "", description: "" }])}
					>
						<Icon name="plus" small />
						{t.commands.add}
					</button>
				</div>
				{rows.length >= BOT_LIMITS.commandsPerScope && <p className="note">{t.commands.tooMany(BOT_LIMITS.commandsPerScope)}</p>}
				{error !== "" && (
					<div className="banner error" role="alert">
						<Icon name="alert" small />
						<span className="grow">{error}</span>
					</div>
				)}
				<div className="card-foot">
					<button type="submit" className="btn btn-primary" disabled={saving} aria-busy={saving}>
						{saving ? t.commands.saving : t.commands.save}
					</button>
				</div>
			</form>
			<div className="card side-card">
				<h2>{t.commands.preview}</h2>
				<p>{t.commands.previewNote[scope]}</p>
				<div className="preview-menu">
					{valid.length === 0 ? (
						<div>
							<span>{t.commands.noValid}</span>
						</div>
					) : (
						valid.map((row) => (
							<div key={row.key}>
								<b>/{row.command.trim()}</b>
								<span>{row.description.trim()}</span>
							</div>
						))
					)}
				</div>
			</div>
		</div>
	);
}
