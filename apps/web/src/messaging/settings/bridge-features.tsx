// The panel of one synced chat that says what is synced for it, feature by
// feature (Chat Bridge, ADR 0023). It lists only what the app supports, so another
// app gets its own panel without changes here. Loaded with the settings tab.
import { useEffect, useState } from "react";
import { Choice } from "../ui/parts.tsx";
import type { BridgeApi, BridgeError } from "./bridge-api.ts";
import {
	FEATURE_LEVELS,
	allowedDirections,
	levelChanges,
	needsConfirm,
	type BridgeFeatureView,
	type FeatureDirection,
	type FeatureLevel,
} from "./bridge-features-model.ts";
import { BridgePeople } from "./bridge-people.tsx";
import { useBridgeCopy } from "./use-bridge-copy.ts";

interface Props {
	readonly accountId: number;
	readonly conversationId: string;
	readonly chatTitle: string;
	readonly appName: string;
	readonly api: BridgeApi;
	readonly disabled: boolean;
	/** Called after a change so the page can refresh what it shows (the direction of the messages). */
	readonly onChanged: () => void;
	readonly onError: (err: unknown) => BridgeError;
}

export function BridgeFeatures({ accountId, conversationId, chatTitle, appName, api, disabled, onChanged, onError }: Props) {
	const t = useBridgeCopy();
	const [list, setList] = useState<readonly BridgeFeatureView[] | "loading" | "failed">("loading");
	const [busy, setBusy] = useState(false);
	const [asking, setAsking] = useState<string | null>(null);
	const [message, setMessage] = useState("");

	const load = () => {
		api.features(accountId, conversationId).then(setList, (err: unknown) => {
			onError(err);
			setList("failed");
		});
	};
	// Loaded when the panel opens; the panel is mounted only while it is open.
	useEffect(load, [accountId, conversationId]); // eslint-disable-line react-hooks/exhaustive-deps

	const nameOf = (feature: string): string => t.features.name[feature] ?? feature;

	const apply = async (changes: ReadonlyMap<string, FeatureDirection>) => {
		setBusy(true);
		setMessage("");
		try {
			// Messages first: the other features follow their direction by default.
			const ordered = [...changes].sort(([a], [b]) => (a === "messages" ? -1 : b === "messages" ? 1 : 0));
			for (const [feature, direction] of ordered) await api.setFeature(accountId, conversationId, feature, direction);
		} catch (err: unknown) {
			const error = onError(err);
			if (error.kind === "feature_unsupported" || error.kind === "send_unsupported") setMessage(t.features.unsupported);
			else if (error.kind !== "reauth") setMessage(t.failed);
		}
		setBusy(false);
		setAsking(null);
		onChanged();
		load();
	};

	const choose = (f: BridgeFeatureView, direction: FeatureDirection) => {
		if (direction === f.direction) return;
		if (needsConfirm(f, direction)) {
			setAsking(`${f.feature}:${direction}`);
			return;
		}
		void apply(new Map([[f.feature, direction]]));
	};

	if (list === "loading") return <p className="br-features note">{t.features.loading}</p>;
	if (list === "failed") {
		return (
			<p className="br-features note">
				{t.loadFailed}{" "}
				<button type="button" className="btn btn-sm" onClick={() => { setList("loading"); load(); }}>
					{t.retry}
				</button>
			</p>
		);
	}
	if (list.length === 0) return <p className="br-features note">{t.features.none}</p>;
	return (
		<section className="br-features" aria-label={t.features.title(chatTitle)} data-id="bridge-features">
			<div className="br-levels">
				<span className="br-send-label">{t.features.levels}</span>
				{FEATURE_LEVELS.map((level: FeatureLevel) => (
					<button key={level} type="button" className="btn btn-sm" disabled={disabled || busy || levelChanges(list, level).size === 0} onClick={() => void apply(levelChanges(list, level))}>
						{t.features.level[level]}
					</button>
				))}
			</div>
			<p className="note">{t.features.levelHint}</p>
			<ul className="br-feature-list">
				{list.map((f) => {
					const asked = asking?.startsWith(`${f.feature}:`) === true ? (asking.slice(f.feature.length + 1) as FeatureDirection) : null;
					return (
						<li key={f.feature} className="br-feature" data-risk={f.risk}>
							<span className="grow br-text">
								<b>{nameOf(f.feature)}</b>
								<small>
									{t.features.risk[f.risk]}
									{f.isDefault && f.feature !== "messages" ? ` · ${t.features.followsMessages}` : ""}
								</small>
							</span>
							<Choice<FeatureDirection>
								label={`${nameOf(f.feature)}: ${chatTitle}`}
								value={f.direction}
								disabled={disabled || busy}
								options={allowedDirections(f)
									.filter((d) => f.feature !== "messages" || d === "in" || d === "both")
									.map((d) => ({ value: d, label: t.features.direction[d] ?? d }))}
								onChange={(d) => choose(f, d)}
							/>
							{asked !== null && (
								<span className="br-actions">
									<span className="note">{t.features.confirm(nameOf(f.feature), appName)}</span>
									<button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void apply(new Map([[f.feature, asked]]))}>
										{t.features.confirmYes}
									</button>
									<button type="button" className="btn btn-sm" onClick={() => setAsking(null)}>
										{t.pick.cancel}
									</button>
								</span>
							)}
						</li>
					);
				})}
			</ul>
			{message !== "" && (
				<p className="note" role="status">
					{message}
				</p>
			)}
			<BridgePeople
				accountId={accountId}
				conversationId={conversationId}
				chatTitle={chatTitle}
				appName={appName}
				api={api}
				features={list}
				disabled={disabled || busy}
				onChanged={onChanged}
				onError={onError}
			/>
		</section>
	);
}
