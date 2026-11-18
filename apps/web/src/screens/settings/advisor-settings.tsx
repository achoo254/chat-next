// Settings › Cố vấn: the Advisor profile kept with the account (name, look,
// tone: every device and the office follow it), whether the mascot shows on
// this device, and the TypeSafe key (advisor-key-section.tsx).
import { useRef, useState, type FormEvent } from "react";
import type { AdvisorTone } from "@achoo254/chat-core";
import { Icon } from "../../components/screen-icons.tsx";
import { useAdvisorProfile, useServices } from "../../messaging/data/services.tsx";
import { Choice, Switch } from "../../messaging/ui/parts.tsx";
import { useHub, useMachineViews, useNow } from "../../machines/use-machines.ts";
import { advisorStore, useAdvisorState } from "../../advisor/advisor-store.ts";
import { LOOKS } from "../../advisor/looks.ts";
import { autoStateOf } from "../../advisor/use-advisor-auto-sync.ts";
import { useAdvisorCopy } from "../../advisor/use-advisor-copy.ts";
import "../../advisor/advisor.css";
import { KeySection } from "./advisor-key-section.tsx";

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
				<AutoRow value={profile.autoSession} save={(on) => save({ autoSession: on })} />
				<div className="row pad-x">
					<span className="grow">{t.settings.show}</span>
					<Switch checked={!hidden} label={t.settings.show} onChange={(on) => advisorStore.setHidden(!on)} />
				</div>
			</div>
			<KeySection />
		</div>
	);
}

/** The account's automatic Advisor switch, and the machines that do not follow it yet (every linked machine is brought in line, see useAdvisorAutoSync). */
function AutoRow({ value, save }: { value: boolean; save: (on: boolean) => void }) {
	const t = useAdvisorCopy();
	const hub = useHub();
	const now = useNow();
	const views = useMachineViews(hub, now);
	const behind = views.filter((view) => {
		const { reachable, auto } = autoStateOf(view);
		return !reachable || auto !== value;
	});
	return (
		<>
			<div className="row pad-x" data-id="advisor-auto">
				<span className="grow">
					<span>{t.settings.auto}</span>
					<small className="muted">{t.settings.autoHint}</small>
				</span>
				<Switch checked={value} label={t.settings.auto} onChange={save} />
			</div>
			{value && behind.length > 0 && <p className="note pad-x">{t.settings.autoNotApplied(behind.map((view) => view.entry.name).join(", "))}</p>}
		</>
	);
}
