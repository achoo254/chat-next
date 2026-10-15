// One webhook (mockups/integrations.html#rotate, #hook-stats,
// #hook-disabled): its settings (name, alert priority and silent sending
// editable with the fields of #create-hook) and on/off switch, taking it over after
// the server turned it off, the secret with its 7-day grace period
// (rotate, revoke the old one now), counters and failed requests, a
// connection guide for its format, its log, and deleting it.
import { useEffect, useState, type FormEvent } from "react";
import type { Chat } from "@app/core";
import { BrandLoader } from "../../components/brand-loader.tsx";
import { Icon } from "../../components/icon.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { Link, navigate, paths } from "../../router.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { useServices } from "../data/services.tsx";
import { Glyph } from "../ui/glyphs.tsx";
import { DialogHead, Modal, Switch, useDomId } from "../ui/parts.tsx";
import { GRACE_SECONDS, HOOK_NAME_MAX, type Hook, type HookNames, type HookWithUrl } from "./api.ts";
import { DeadLettersCard, StatsCard } from "./hook-activity.tsx";
import { HookAudit } from "./hook-audit.tsx";
import { HookGuide } from "./hook-guide.tsx";
import { countdown, formatLabel, HookAvatar, hookErrorCode, OneTimeUrlDialog, stateView, useNow, whenText } from "./hook-parts.tsx";
import { useHooksCopy } from "./use-hooks-copy.ts";

type NameOf = (userId: number) => string;

interface DetailState {
	readonly hook: Hook | null;
	readonly names: HookNames;
	readonly status: "loading" | "ready" | "error" | "gone";
}

export function HookDetail({ chat, hookId }: { chat: Chat; hookId: string }) {
	const copy = useCopy();
	const t = useHooksCopy();
	const { locale } = useI18n();
	const { integrations, store } = useServices();
	const [state, setState] = useState<DetailState>({ hook: null, names: new Map(), status: "loading" });
	const [attempt, setAttempt] = useState(0);
	// Shown once after a rotation or a take-over with a new secret, then dropped.
	const [once, setOnce] = useState<HookWithUrl | null>(null);
	// Turning on failed because the creator is no longer an admin: offer the take-over.
	const [needTakeOver, setNeedTakeOver] = useState(false);
	const hook = state.hook;
	const now = useNow(false);
	const channel = chat.type === "channel";

	useEffect(() => {
		let active = true;
		integrations.hook(hookId).then(
			({ hook: loaded, names }) => {
				if (active) setState({ hook: loaded, names, status: "ready" });
			},
			(err: unknown) => {
				if (active) setState((current) => ({ ...current, status: hookErrorCode(err) === "not_found" ? "gone" : "error" }));
			},
		);
		return () => {
			active = false;
		};
	}, [integrations, hookId, attempt]);

	const nameOf: NameOf = (userId) => (userId === store.selfId ? copy.common.you : (state.names.get(userId) ?? copy.message.unknownUser));
	const update = (next: Hook) => setState((current) => ({ ...current, hook: next }));

	if (state.status === "gone") {
		return (
			<div className="hooks-body">
				<div className="card empty">
					<Icon name="webhook" />
					<span>{t.detail.gone}</span>
					<Link to={paths.hooks(chat.id)} className="btn">
						{t.backToList}
					</Link>
				</div>
			</div>
		);
	}
	if (hook === null) {
		return (
			<div className="hooks-body">
				{state.status === "error" ? (
					<div className="banner error" role="alert">
						<Icon name="alert" small />
						<span className="grow">{copy.common.loadFailed}</span>
						<button
							type="button"
							className="btn btn-sm"
							onClick={() => {
								setState((current) => ({ ...current, status: "loading" }));
								setAttempt((n) => n + 1);
							}}
						>
							{copy.common.retry}
						</button>
					</div>
				) : (
					<BrandLoader label={copy.common.loading} />
				)}
			</div>
		);
	}

	const view = stateView(hook, now, t, channel);
	const creator = nameOf(hook.createdBy);
	const takeOver = hook.state === "auto_disabled" || needTakeOver;
	return (
		<div className="hooks-body">
			<div className="hooks-title">
				<HookAvatar hook={hook} size="md" />
				<h2>{hook.name}</h2>
				<span className={`dot ${view.tone}`}>{view.label}</span>
			</div>
			{hook.state === "auto_disabled" && (
				<div className="banner error" role="status">
					<Icon name="ban" small />
					<span className="grow">
						{t.detail.autoDisabledBanner(creator, whenText(hook.disabledAt, now, locale, copy), hook.disabledReason === "creator_left", channel)}
					</span>
				</div>
			)}
			{hook.state === "disabled" && (
				<div className="banner warn" role="status">
					<Icon name="alert" small />
					<span className="grow">{t.detail.disabledBanner(whenText(hook.disabledAt, now, locale, copy))}</span>
				</div>
			)}
			<div className="hook-grid">
				<div className="hook-col">
					{takeOver && (
						<TakeOverCard
							hook={hook}
							creator={creator}
							onDone={(result) => {
								update(result.hook);
								setNeedTakeOver(false);
								if (result.url !== "") setOnce(result);
							}}
						/>
					)}
					<InfoCard hook={hook} nameOf={nameOf} now={now} onHook={update} onNeedTakeOver={() => setNeedTakeOver(true)} />
					<SecretCard hook={hook} nameOf={nameOf} onHook={update} onRotated={setOnce} />
					<StatsCard hookId={hook.id} />
					<DeadLettersCard hookId={hook.id} />
				</div>
				<div className="hook-col">
					<HookGuide hook={hook} chatTitle={chat.title} />
					<HookAudit
						key={`${hook.state}:${hook.secretCreatedAt}:${hook.previousSecretExpiresAt}:${hook.name}:${hook.allowAlert}:${hook.silent}`} chatId={chat.id} hookId={hook.id} />
					<DangerCard hook={hook} chatId={chat.id} />
				</div>
			</div>
			{once !== null && (
				<OneTimeUrlDialog
					title={t.oneTime.rotatedTitle(once.hook.name)}
					url={once.url}
					format={once.hook.format}
					hookName={once.hook.name}
					chatTitle={chat.title}
					onDone={() => setOnce(null)}
				/>
			)}
		</div>
	);
}

interface CardProps {
	hook: Hook;
	nameOf: NameOf;
	now: number;
	onHook: (hook: Hook) => void;
}

function InfoCard({ hook, nameOf, now, onHook, onNeedTakeOver }: CardProps & { onNeedTakeOver: () => void }) {
	const copy = useCopy();
	const t = useHooksCopy();
	const { locale } = useI18n();
	const { integrations, toasts } = useServices();
	const [busy, setBusy] = useState(false);
	const [editing, setEditing] = useState(false);
	const id = useDomId("hook-info");
	const toggle = (enabled: boolean) => {
		setBusy(true);
		integrations.setEnabled(hook.id, enabled).then(
			(next) => {
				setBusy(false);
				onHook(next);
				toasts.show(enabled ? t.detail.turnedOn(next.name) : t.detail.turnedOff(next.name));
			},
			(err: unknown) => {
				setBusy(false);
				if (hookErrorCode(err) === "creator_not_admin") {
					onNeedTakeOver();
					toasts.show(t.detail.creatorNotAdmin);
				} else toasts.show(copy.common.failed);
			},
		);
	};
	return (
		<section className="card" aria-labelledby={id}>
			<h3 id={id}>{t.detail.info}</h3>
			<dl className="facts">
				<div>
					<dt>{t.detail.format}</dt>
					<dd className="fmt">{formatLabel(hook.format, t)}</dd>
				</div>
				<div>
					<dt>{t.detail.createdBy}</dt>
					<dd>{t.detail.createdLine(nameOf(hook.createdBy), whenText(hook.createdAt, now, locale, copy))}</dd>
				</div>
				<div>
					<dt>{t.detail.lastUsed}</dt>
					<dd>{hook.lastUsedAt === 0 ? t.neverUsed : whenText(hook.lastUsedAt, now, locale, copy)}</dd>
				</div>
				<div>
					<dt>{t.detail.silent}</dt>
					<dd>{hook.silent ? t.detail.on : t.detail.off}</dd>
				</div>
				<div>
					<dt>{t.detail.allowAlert}</dt>
					<dd>{hook.allowAlert ? t.detail.allowed : t.detail.notAllowed}</dd>
				</div>
			</dl>
			{hook.state !== "auto_disabled" && (
				<div className="setting">
					<div>
						<strong>{t.detail.receiving}</strong>
						<small id={`${id}-recv`}>{t.detail.receivingNote}</small>
					</div>
					<Switch checked={hook.state === "active"} label={t.detail.receiving} describedBy={`${id}-recv`} disabled={busy} onChange={toggle} />
				</div>
			)}
			<div className="card-foot">
				<button type="button" className="btn" onClick={() => setEditing(true)}>
					<Icon name="edit" />
					{t.editDialog.open}
				</button>
			</div>
			{editing && (
				<EditHookDialog
					hook={hook}
					onClose={() => setEditing(false)}
					onSaved={(next) => {
						setEditing(false);
						onHook(next);
					}}
				/>
			)}
		</section>
	);
}

/** Name, alert priority and silent sending, as on the create form; the format stays (it is part of the URL). */
function EditHookDialog({ hook, onClose, onSaved }: { hook: Hook; onClose: () => void; onSaved: (hook: Hook) => void }) {
	const copy = useCopy();
	const t = useHooksCopy();
	const { integrations, toasts } = useServices();
	const [name, setName] = useState(hook.name);
	const [allowAlert, setAllowAlert] = useState(hook.allowAlert);
	const [silent, setSilent] = useState(hook.silent);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const id = useDomId("hook-edit");
	const trimmed = name.trim();
	// Code points, as the server counts the name.
	const length = Array.from(trimmed).length;
	const nameError = length === 0 ? t.form.nameRequired : length > HOOK_NAME_MAX ? t.form.nameTooLong(HOOK_NAME_MAX) : "";
	const unchanged = trimmed === hook.name && allowAlert === hook.allowAlert && silent === hook.silent;

	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (busy) return;
		if (unchanged) {
			onClose();
			return;
		}
		if (nameError !== "") return;
		setBusy(true);
		setError("");
		integrations.update(hook.id, { name: trimmed, allowAlert, silent }).then(
			(next) => {
				toasts.show(t.editDialog.saved(next.name));
				onSaved(next);
			},
			(err: unknown) => {
				setBusy(false);
				if (hookErrorCode(err) === "invalid") setError(t.form.invalid);
				else toasts.show(copy.common.failed);
			},
		);
	};

	return (
		<Modal labelledBy={id} onClose={onClose} className="narrow">
			<form onSubmit={submit} noValidate>
				<DialogHead id={id} title={t.editDialog.title(hook.name)} onClose={onClose} />
				<div className="dlg-body stack">
					<div className="field">
						<label htmlFor={`${id}-name`}>{t.form.name}</label>
						<input
							id={`${id}-name`}
							className="input"
							value={name}
							autoComplete="off"
							maxLength={HOOK_NAME_MAX * 2}
							aria-invalid={nameError !== ""}
							aria-describedby={`${id}-name-hint`}
							onChange={(event) => setName(event.target.value)}
						/>
						<span className="hint" id={`${id}-name-hint`}>
							{nameError !== "" ? <span className="field-error">{nameError}</span> : t.editDialog.nameHint}
						</span>
					</div>
					<div className="setting">
						<div>
							<strong>{t.form.allowAlert}</strong>
							<small id={`${id}-alert`}>{t.form.allowAlertNote}</small>
						</div>
						<Switch checked={allowAlert} label={t.form.allowAlert} describedBy={`${id}-alert`} onChange={setAllowAlert} />
					</div>
					<div className="setting">
						<div>
							<strong>{t.form.silent}</strong>
							<small id={`${id}-silent`}>{t.form.silentNote}</small>
						</div>
						<Switch checked={silent} label={t.form.silent} describedBy={`${id}-silent`} onChange={setSilent} />
					</div>
					<p className="note">
						<Icon name="info" />
						<span>{t.editDialog.formatNote(formatLabel(hook.format, t))}</span>
					</p>
					{error !== "" && (
						<div className="banner error" role="alert">
							<Icon name="alert" small />
							<span className="grow">{error}</span>
						</div>
					)}
				</div>
				<div className="dlg-foot">
					<button type="button" className="btn" onClick={onClose}>
						{copy.common.cancel}
					</button>
					<button type="submit" className="btn btn-primary" aria-busy={busy} disabled={busy || (nameError !== "" && !unchanged)}>
						{busy ? t.editDialog.saving : t.editDialog.save}
					</button>
				</div>
			</form>
		</Modal>
	);
}

function TakeOverCard({ hook, creator, onDone }: { hook: Hook; creator: string; onDone: (result: HookWithUrl) => void }) {
	const copy = useCopy();
	const t = useHooksCopy();
	const { integrations, toasts } = useServices();
	const [rotate, setRotate] = useState(false);
	const [busy, setBusy] = useState(false);
	const id = useDomId("take");
	const take = () => {
		setBusy(true);
		integrations.takeOver(hook.id, rotate).then(
			(result) => {
				setBusy(false);
				toasts.show(result.url === "" ? t.detail.takenOver : t.detail.takenOverRotated);
				onDone(result);
			},
			() => {
				setBusy(false);
				toasts.show(copy.common.failed);
			},
		);
	};
	return (
		<section className="card take-over" aria-labelledby={id}>
			<h3 id={id}>{t.detail.takeOver}</h3>
			<p>{t.detail.takeOverNote}</p>
			<div className="setting">
				<div>
					<strong>{t.detail.rotateOnTakeOver}</strong>
					<small id={`${id}-note`}>{t.detail.rotateOnTakeOverNote(creator)}</small>
				</div>
				<Switch checked={rotate} label={t.detail.rotateOnTakeOver} describedBy={`${id}-note`} onChange={setRotate} />
			</div>
			<div className="card-foot">
				<button type="button" className="btn btn-primary" aria-busy={busy} disabled={busy} onClick={take}>
					{t.detail.takeOver}
				</button>
			</div>
		</section>
	);
}

/** The grace countdown ticks here only, so the rest of the page does not render every second. */
function SecretCard({ hook, nameOf, onHook, onRotated }: Omit<CardProps, "now"> & { onRotated: (result: HookWithUrl) => void }) {
	const now = useNow(hook.previousSecretExpiresAt > 0);
	const copy = useCopy();
	const t = useHooksCopy();
	const { locale } = useI18n();
	const { integrations, toasts } = useServices();
	const [rotating, setRotating] = useState(false);
	const [busy, setBusy] = useState(false);
	const id = useDomId("secret");
	const left = hook.previousSecretExpiresAt - now;
	const grace = left > 0;
	const elapsed = Math.min(100, Math.max(0, Math.round(((GRACE_SECONDS - left) / GRACE_SECONDS) * 100)));
	const revoke = () => {
		setBusy(true);
		integrations.revokePrevious(hook.id).then(
			(next) => {
				setBusy(false);
				onHook(next);
				toasts.show(t.detail.revokedPrevious);
			},
			(err: unknown) => {
				setBusy(false);
				if (hookErrorCode(err) === "no_previous_secret") {
					onHook({ ...hook, previousSecretExpiresAt: 0 });
					toasts.show(t.detail.noPrevious);
				} else toasts.show(copy.common.failed);
			},
		);
	};
	return (
		<section className="card" aria-labelledby={id}>
			<h3 id={id}>{t.detail.secretTitle}</h3>
			<p>{t.detail.secretNote}</p>
			<div className="secret-rows">
				<div className="secret-row">
					<span>
						<span className={`dot ${hook.state === "active" ? "ok" : "off"}`}>{t.detail.currentSecret}</span>
						<span className="cell-sub">{t.detail.currentSecretSub(whenText(hook.secretCreatedAt, now, locale, copy), nameOf(hook.secretCreatedBy))}</span>
					</span>
					<span className="note">{hook.state === "active" ? t.detail.accepting : t.detail.refused}</span>
				</div>
				{grace && (
					<div className="secret-row">
						<span>
							<span className="dot warn">{t.detail.previousSecret}</span>
							<span className="cell-sub">{t.detail.previousSecretSub}</span>
						</span>
						<span>
							{t.detail.expiresIn} <span className="countdown">{countdown(left, t)}</span>
						</span>
						<div className="progress" role="progressbar" aria-label={t.detail.graceProgress} aria-valuemin={0} aria-valuemax={100} aria-valuenow={elapsed}>
							<span style={{ width: `${Math.max(elapsed, 1)}%` }} />
						</div>
					</div>
				)}
			</div>
			<div className="card-foot">
				{grace && (
					<button type="button" className="btn danger-text" aria-busy={busy} disabled={busy} onClick={revoke}>
						{t.detail.revokePrevious}
					</button>
				)}
				<button type="button" className="btn" onClick={() => setRotating(true)}>
					<Glyph name="key" />
					{t.detail.rotate}
				</button>
			</div>
			{rotating && (
				<RotateDialog
					hook={hook}
					onClose={() => setRotating(false)}
					onRotated={(result) => {
						setRotating(false);
						onHook(result.hook);
						onRotated(result);
					}}
				/>
			)}
		</section>
	);
}

function RotateDialog({ hook, onClose, onRotated }: { hook: Hook; onClose: () => void; onRotated: (result: HookWithUrl) => void }) {
	const copy = useCopy();
	const t = useHooksCopy();
	const { integrations, toasts } = useServices();
	const [revokeNow, setRevokeNow] = useState(false);
	const [busy, setBusy] = useState(false);
	const id = useDomId("rotate");
	const rotate = () => {
		setBusy(true);
		integrations.rotate(hook.id, revokeNow).then(onRotated, () => {
			setBusy(false);
			toasts.show(copy.common.failed);
		});
	};
	return (
		<Modal labelledBy={id} onClose={onClose} className="narrow">
			<DialogHead id={id} title={t.rotateDialog.title(hook.name)} onClose={onClose} />
			<div className="dlg-body stack">
				<p className="note">
					<Icon name="info" />
					<span>{t.rotateDialog.note}</span>
				</p>
				<div className="setting">
					<div>
						<strong>{t.rotateDialog.revokeNow}</strong>
						<small id={`${id}-note`}>{t.rotateDialog.revokeNowNote}</small>
					</div>
					<Switch checked={revokeNow} label={t.rotateDialog.revokeNow} describedBy={`${id}-note`} onChange={setRevokeNow} />
				</div>
			</div>
			<div className="dlg-foot">
				<button type="button" className="btn" onClick={onClose}>
					{copy.common.cancel}
				</button>
				<button type="button" className="btn btn-primary" aria-busy={busy} disabled={busy} onClick={rotate}>
					{t.rotateDialog.confirm}
				</button>
			</div>
		</Modal>
	);
}

function DangerCard({ hook, chatId }: { hook: Hook; chatId: number }) {
	const t = useHooksCopy();
	const [confirming, setConfirming] = useState(false);
	const id = useDomId("hook-danger");
	return (
		<section className="card danger-zone" aria-labelledby={id}>
			<h3 id={id}>{t.detail.dangerTitle}</h3>
			<p>{t.detail.dangerNote}</p>
			<div className="actions">
				<button type="button" className="btn danger-text" onClick={() => setConfirming(true)}>
					<Icon name="trash" />
					{t.detail.delete}
				</button>
			</div>
			{confirming && <DeleteHookDialog hook={hook} chatId={chatId} onClose={() => setConfirming(false)} />}
		</section>
	);
}

function DeleteHookDialog({ hook, chatId, onClose }: { hook: Hook; chatId: number; onClose: () => void }) {
	const copy = useCopy();
	const t = useHooksCopy();
	const { integrations, toasts } = useServices();
	const [busy, setBusy] = useState(false);
	const id = useDomId("hook-del");
	const remove = () => {
		setBusy(true);
		integrations.remove(hook.id).then(
			() => {
				toasts.show(t.deleteDialog.deleted(hook.name));
				navigate(paths.hooks(chatId), { replace: true });
			},
			() => {
				setBusy(false);
				toasts.show(copy.common.failed);
			},
		);
	};
	return (
		<Modal labelledBy={id} onClose={onClose} className="narrow">
			<DialogHead id={id} title={t.deleteDialog.title(hook.name)} onClose={onClose} />
			<div className="dlg-body stack">
				<p className="note">
					<Icon name="alert-triangle" />
					<span>{t.deleteDialog.note}</span>
				</p>
			</div>
			<div className="dlg-foot">
				<button type="button" className="btn" onClick={onClose}>
					{copy.common.cancel}
				</button>
				<button type="button" className="btn btn-danger" aria-busy={busy} disabled={busy} onClick={remove}>
					{t.deleteDialog.confirm}
				</button>
			</div>
		</Modal>
	);
}
