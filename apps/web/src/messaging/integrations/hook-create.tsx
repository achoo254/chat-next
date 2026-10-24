// New webhook (mockups/integrations.html#create-hook, #hook-created): name
// (the "Tích hợp: <tên>" label), format (it decides the URL suffix), alert
// priority and silent sending, with a preview of how its messages look.
// On success the URL shows once; closing it opens the webhook's page.
import { useState, type FormEvent } from "react";
import type { Chat } from "@achoo254/chat-core";
import { Icon } from "../../components/icon.tsx";
import { Link, navigate, paths } from "../../router.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { integrationTone } from "../data/format.ts";
import { useServices } from "../data/services.tsx";
import { Switch, useDomId } from "../ui/parts.tsx";
import { HOOK_FORMATS, HOOK_NAME_MAX, HOOKS_PER_CHAT_MAX, type HookFormat, type HookWithUrl } from "./api.ts";
import { formatLabel, hookErrorCode, OneTimeUrlDialog } from "./hook-parts.tsx";
import { useHooksCopy } from "./use-hooks-copy.ts";

export function HookCreate({ chat }: { chat: Chat }) {
	const copy = useCopy();
	const t = useHooksCopy();
	const { integrations, toasts } = useServices();
	const [name, setName] = useState("");
	const [format, setFormat] = useState<HookFormat>("slack");
	const [allowAlert, setAllowAlert] = useState(false);
	const [silent, setSilent] = useState(false);
	const [busy, setBusy] = useState(false);
	const [touched, setTouched] = useState(false);
	const [error, setError] = useState("");
	// The one-time URL lives here only until the dialog closes.
	const [created, setCreated] = useState<HookWithUrl | null>(null);
	const id = useDomId("hook-new");
	const trimmed = name.trim();
	// Code points, as the server counts the name.
	const length = Array.from(trimmed).length;
	const nameError = length === 0 ? t.form.nameRequired : length > HOOK_NAME_MAX ? t.form.nameTooLong(HOOK_NAME_MAX) : "";

	const submit = (event: FormEvent) => {
		event.preventDefault();
		setTouched(true);
		if (nameError !== "" || busy) return;
		setBusy(true);
		setError("");
		integrations.create(chat.id, { name: trimmed, format, allowAlert, silent }).then(
			(result) => {
				setBusy(false);
				setCreated(result);
			},
			(err: unknown) => {
				setBusy(false);
				const code = hookErrorCode(err);
				if (code === "hooks_limit") setError(t.form.limit(HOOKS_PER_CHAT_MAX));
				else if (code === "invalid") setError(t.form.invalid);
				else toasts.show(copy.common.failed);
			},
		);
	};

	const preview = trimmed === "" ? "…" : trimmed;
	return (
		<div className="hooks-body">
			<div className="hook-grid">
				<form className="card hook-form" onSubmit={submit} noValidate aria-labelledby={`${id}-title`}>
					<h3 id={`${id}-title`}>{t.create}</h3>
					<div className="field">
						<label htmlFor={`${id}-name`}>{t.form.name}</label>
						<input
							id={`${id}-name`}
							className="input"
							value={name}
							autoComplete="off"
							maxLength={HOOK_NAME_MAX * 2}
							aria-invalid={touched && nameError !== ""}
							aria-describedby={`${id}-name-hint`}
							onChange={(event) => setName(event.target.value)}
						/>
						<span className="hint" id={`${id}-name-hint`}>
							{touched && nameError !== "" ? <span className="field-error">{nameError}</span> : t.form.nameHint}
						</span>
					</div>
					<fieldset className="field">
						<legend className="label">{t.form.format}</legend>
						<span className="hint">{t.form.formatHint}</span>
						<div className="radio-cards">
							{HOOK_FORMATS.map((option) => (
								<label key={option} className="radio-card">
									<input type="radio" name={`${id}-format`} value={option} checked={format === option} onChange={() => setFormat(option)} />
									<span>
										<b>{formatLabel(option, t)}</b>
										<span>{t.formats[option].note}</span>
									</span>
								</label>
							))}
						</div>
					</fieldset>
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
					{error !== "" && (
						<div className="banner error" role="alert">
							<Icon name="alert" small />
							<span className="grow">{error}</span>
						</div>
					)}
					<div className="card-foot">
						<Link to={paths.hooks(chat.id)} className="btn">
							{copy.common.cancel}
						</Link>
						<button type="submit" className="btn btn-primary" aria-busy={busy} disabled={busy}>
							{busy ? t.creating : t.create}
						</button>
					</div>
				</form>
				<section className="card" aria-labelledby={`${id}-preview`}>
					<h3 id={`${id}-preview`}>{t.form.previewTitle}</h3>
					<div className="hook-preview" aria-hidden="true">
						<span className={`avatar sm av-${integrationTone(preview)}`}>
							<Icon name="webhook" small />
						</span>
						<div className="bubble integration firing">
							<span className="int-label">
								<Icon name="webhook" />
								{copy.message.integration(preview)}
							</span>
							<p className="int-title">
								<span className="sev firing">{copy.message.alertFiring}</span>
								{t.form.previewText}
							</p>
						</div>
					</div>
					<p>{t.form.previewNote}</p>
				</section>
			</div>
			{created !== null && (
				<OneTimeUrlDialog
					title={t.oneTime.createdTitle(created.hook.name)}
					url={created.url}
					format={created.hook.format}
					hookName={created.hook.name}
					chatTitle={chat.title}
					onDone={() => {
						const hookId = created.hook.id;
						setCreated(null);
						navigate(paths.hook(chat.id, hookId), { replace: true });
					}}
				/>
			)}
		</div>
	);
}
