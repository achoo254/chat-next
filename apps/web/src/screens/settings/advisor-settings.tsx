// Settings › Cố vấn: the Advisor profile kept with the account (name, look,
// tone: every device and the office follow it), whether the mascot shows on
// this device, and the TypeSafe key of each machine (its state, fingerprint,
// which device set it and when; paste a new one, remove it). The key goes to
// the machine end-to-end encrypted (AdvisorSetKey) and never comes back;
// the section is never offered to Advisor's copy chip (data-advisor-ignore).
// The only place in the app that names Jev and TypeSafe.
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AdvisorTone } from "@achoo254/chat-core";
import { Icon } from "../../components/screen-icons.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { useAdvisorProfile, useServices } from "../../messaging/data/services.tsx";
import { Choice, Switch } from "../../messaging/ui/parts.tsx";
import { errorText, useHub, useMachineViews, useNow, type MachineView } from "../../machines/use-machines.ts";
import { useMachinesCopy } from "../../machines/use-machines-copy.ts";
import { IGNORE_ATTR } from "../../advisor/advisor-context.tsx";
import { advisorStore, useAdvisorState } from "../../advisor/advisor-store.ts";
import { LOOKS } from "../../advisor/looks.ts";
import { useAdvisorCopy } from "../../advisor/use-advisor-copy.ts";
import "../../advisor/advisor.css";

/** Characters of the name (the server checks it too). */
const NAME_MAX = 32;

export default function AdvisorSettings() {
	const t = useAdvisorCopy();
	const { store, toasts } = useServices();
	const profile = useAdvisorProfile();
	const { hidden } = useAdvisorState();
	const [name, setName] = useState(profile.name);
	// The saved name changed elsewhere (another device): the field follows it.
	const [savedName, setSavedName] = useState(profile.name);
	if (profile.name !== savedName) {
		setSavedName(profile.name);
		setName(profile.name);
	}
	const save = (change: Parameters<typeof store.setAdvisorProfile>[0]) => {
		store.setAdvisorProfile(change).catch(() => toasts.show(t.settings.saveFailed));
	};
	/** The name sent last: Enter then leaving the field saves it once. */
	const sentName = useRef(profile.name);
	const saveName = (event?: FormEvent) => {
		event?.preventDefault();
		const next = name.trim().slice(0, NAME_MAX);
		if (next === profile.name || next === sentName.current) return;
		sentName.current = next;
		save({ name: next });
	};
	const tones: { value: AdvisorTone; label: string }[] = [
		{ value: "short", label: t.settings.tones.short },
		{ value: "fun", label: t.settings.tones.fun },
		{ value: "serious", label: t.settings.tones.serious },
	];
	return (
		<div className="set-body adv-settings">
			<p className="lede">
				<Icon name="bulb" small />
				{t.settings.intro}
			</p>
			<div className="card" data-id="advisor-profile">
				<h2 className="card-title">{t.settings.profile}</h2>
				<form className="row pad-x" onSubmit={saveName}>
					<label className="grow" htmlFor="advisor-name">
						{t.settings.name}
					</label>
					<input
						id="advisor-name"
						className="input adv-name"
						value={name}
						maxLength={NAME_MAX}
						placeholder={t.defaultName}
						onChange={(event) => setName(event.target.value)}
						onBlur={() => saveName()}
					/>
				</form>
				<div className="pad-x adv-looks-row">
					<span>{t.settings.look}</span>
					<div className="adv-looks" role="group" aria-label={t.settings.look}>
						{LOOKS.map((look) => (
							<button
								key={look.id}
								type="button"
								className="adv-look"
								aria-pressed={profile.lookId === look.id}
								aria-label={t.settings.looks[look.id] ?? look.id}
								style={{ borderColor: profile.lookId === look.id ? look.colors.accent : undefined }}
								onClick={() => save({ lookId: look.id })}
							>
								<img src={look.pictures.idle} alt="" />
								<small>{t.settings.looks[look.id] ?? look.id}</small>
							</button>
						))}
					</div>
				</div>
				<div className="row pad-x">
					<span className="grow">{t.settings.tone}</span>
					<Choice<AdvisorTone> label={t.settings.tone} value={profile.tone} options={tones} onChange={(tone) => save({ tone })} />
				</div>
				<div className="row pad-x">
					<span className="grow">{t.settings.show}</span>
					<Switch checked={!hidden} label={t.settings.show} onChange={(on) => advisorStore.setHidden(!on)} />
				</div>
			</div>
			<KeySection />
		</div>
	);
}

/** Each machine's key, from its MachineInfo.advisor (links open only to machines online). */
function KeySection() {
	const t = useAdvisorCopy();
	const hub = useHub();
	const now = useNow();
	const views = useMachineViews(hub, now);
	useEffect(() => {
		hub.device().catch(() => undefined);
		if (hub.directory().status !== "ready") hub.refresh().catch(() => undefined);
	}, [hub]);
	return (
		<div className="card" data-id="advisor-keys" {...{ [IGNORE_ATTR]: "" }}>
			<h2 className="card-title">{t.key.title}</h2>
			<p className="note pad-x">{t.key.model}</p>
			{views.length === 0 ? <p className="note pad-x">{t.key.none}</p> : views.map((view) => <MachineKey key={view.entry.ref} view={view} />)}
		</div>
	);
}

function MachineKey({ view }: { view: MachineView }) {
	const t = useAdvisorCopy();
	const tm = useMachinesCopy();
	const { locale } = useI18n();
	const [mode, setMode] = useState<"view" | "paste" | "remove">("view");
	const [key, setKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const info = view.state.info;
	const open = view.state.status.kind === "open";
	const advisor = info?.advisor;
	let status: string;
	if (!open) status = view.conn.kind === "offline" ? t.key.offline : t.ask.connecting;
	else if (info === null) status = t.ask.connecting;
	else if (advisor === undefined) status = t.key.update;
	else if (!advisor.available) status = t.key.mcpOff;
	else status = advisor.keySet ? t.key.keySet(advisor.keyFingerprint) : t.key.noKey;
	const usable = open && advisor !== undefined;
	const setBy =
		advisor?.keySet === true && advisor.setByDevice !== ""
			? t.key.setBy(advisor.setByDevice === "local" ? t.key.localDevice : advisor.setByDevice, new Date(Number(advisor.setAt)).toLocaleString(locale))
			: "";
	const run = (request: () => Promise<unknown>) => {
		setBusy(true);
		setError("");
		request()
			.then(() => {
				setMode("view");
				setKey("");
			})
			.catch((err: unknown) => setError(errorText(tm, err, "AI") || t.key.failed))
			.finally(() => setBusy(false));
	};
	const paste = (event: FormEvent) => {
		event.preventDefault();
		const value = key.trim();
		if (value === "") return;
		run(() => view.link.request({ case: "advisorSetKey", value: { key: value } }));
	};
	return (
		<div className="adv-machine-key pad-x" data-id={`advisor-key-${view.entry.ref}`}>
			<div className="row">
				<span className="grow">
					{view.entry.name}
					<small>{status}</small>
					{setBy !== "" && <small>{setBy}</small>}
				</span>
				{usable && mode === "view" && (
					<span className="adv-acts">
						<button type="button" className="btn btn-sm" onClick={() => setMode("paste")}>
							{t.key.paste}
						</button>
						{advisor.keySet && (
							<button type="button" className="btn btn-sm" onClick={() => setMode("remove")}>
								{t.key.remove}
							</button>
						)}
					</span>
				)}
			</div>
			{mode === "paste" && (
				<form className="adv-key-form" onSubmit={paste}>
					<input
						className="input"
						type="password"
						autoComplete="off"
						spellCheck={false}
						aria-label={t.key.field}
						placeholder={t.key.field}
						maxLength={4096}
						value={key}
						onChange={(event) => setKey(event.target.value)}
					/>
					<span className="adv-acts">
						<button type="button" className="btn btn-sm" onClick={() => setMode("view")}>
							{t.key.cancel}
						</button>
						<button type="submit" className="btn btn-sm btn-primary" disabled={busy || key.trim() === ""}>
							{t.key.save}
						</button>
					</span>
				</form>
			)}
			{mode === "remove" && (
				<div className="adv-key-form" role="alert">
					<p>{t.key.confirmRemove}</p>
					<span className="adv-acts">
						<button type="button" className="btn btn-sm" onClick={() => setMode("view")}>
							{t.key.cancel}
						</button>
						<button type="button" className="btn-danger-text" disabled={busy} onClick={() => run(() => view.link.request({ case: "advisorRemoveKey", value: {} }))}>
							{t.key.remove}
						</button>
					</span>
				</div>
			)}
			{error !== "" && (
				<p className="note mx-error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}
