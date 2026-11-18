// Account-wide tools of the bridge: what a new synced chat starts with, feature by feature
// (with "apply to all chats"), and the one place that lists everything Chat sent to the other
// app that did not go through, whatever the feature. Loaded when the account page opens.
import { useEffect, useState } from "react";
import { Choice } from "../ui/parts.tsx";
import type { BridgeApi, BridgeError, BridgeFeatureDefaultView, BridgeProblem } from "./bridge-api.ts";
import { allowedDirections, type FeatureDirection } from "./bridge-features-model.ts";
import { useBridgeCopy } from "./use-bridge-copy.ts";

interface Props {
	readonly accountId: number;
	readonly api: BridgeApi;
	readonly appName: string;
	readonly chatCount: number;
	readonly onChange: () => void;
	readonly onError: (err: unknown) => BridgeError;
}

export function BridgeAccountTools(props: Props) {
	return (
		<div className="br-tools" data-id="bridge-account-tools">
			<Defaults {...props} />
			<Problems {...props} />
		</div>
	);
}

function Defaults({ accountId, api, appName, chatCount, onChange, onError }: Props) {
	const t = useBridgeCopy();
	const [list, setList] = useState<readonly BridgeFeatureDefaultView[] | null>(null);
	const [applyAll, setApplyAll] = useState(false);
	const [note, setNote] = useState("");
	const load = () => {
		api.featureDefaults(accountId).then(setList, (err: unknown) => {
			onError(err);
			setList([]);
		});
	};
	useEffect(load, [accountId]); // eslint-disable-line react-hooks/exhaustive-deps
	const choose = (f: BridgeFeatureDefaultView, direction: FeatureDirection) => {
		api.setFeatureDefault(accountId, f.feature, direction, applyAll).then(
			(n) => {
				setNote(applyAll ? t.defaults.applied(n) : t.defaults.saved);
				load();
				if (applyAll) onChange();
			},
			(err: unknown) => {
				onError(err);
				setNote(t.failed);
			},
		);
	};
	return (
		<details className="br-tool">
			<summary>{t.defaults.title}</summary>
			<p className="note">{t.defaults.hint(appName)}</p>
			{list?.length === 0 && <p className="note">{t.features.none}</p>}
			<ul className="br-feature-list">
				{list?.map((f) => (
					<li key={f.feature} className="br-feature" data-risk={f.risk}>
						<span className="grow br-text">
							<b>{t.features.name[f.feature] ?? f.feature}</b>
							<small>{f.isSet ? t.defaults.chosen : t.defaults.builtIn}</small>
						</span>
						<Choice<FeatureDirection>
							label={`${t.defaults.title}: ${t.features.name[f.feature] ?? f.feature}`}
							value={f.direction}
							options={allowedDirections(f).map((d) => ({ value: d, label: t.features.direction[d] ?? d }))}
							onChange={(d) => choose(f, d)}
						/>
					</li>
				))}
			</ul>
			<label className="br-check">
				<input type="checkbox" checked={applyAll} onChange={(e) => setApplyAll(e.target.checked)} />
				{t.defaults.applyAll(chatCount)}
			</label>
			{note !== "" && (
				<p className="note" role="status">
					{note}
				</p>
			)}
		</details>
	);
}

function Problems({ accountId, api, onChange, onError }: Props) {
	const t = useBridgeCopy();
	const [list, setList] = useState<readonly BridgeProblem[] | null>(null);
	const load = () => {
		api.problems(accountId).then(setList, (err: unknown) => {
			onError(err);
			setList([]);
		});
	};
	useEffect(load, [accountId]); // eslint-disable-line react-hooks/exhaustive-deps
	const act = (run: () => Promise<void>) => {
		run().then(
			() => {
				load();
				onChange();
			},
			(err: unknown) => {
				onError(err);
				load();
			},
		);
	};
	return (
		<details className="br-tool" open={(list?.length ?? 0) > 0}>
			<summary>{t.problems.title(list?.length ?? 0)}</summary>
			{list?.length === 0 && <p className="note">{t.problems.none}</p>}
			<ul className="br-problem-list">
				{list?.map((p) => (
					<li key={p.id} className="br-problem">
						<span className="grow br-text">
							<b>
								{t.features.name[p.feature] ?? p.feature} · {p.chatTitle}
							</b>
							<small>
								{p.status === "unknown" ? t.problems.unknown : t.problems.failed}
								{p.lastError !== "" ? ` · ${p.lastError}` : ""}
							</small>
						</span>
						<button type="button" className="btn btn-sm" onClick={() => act(() => api.retryProblem(accountId, p.id))}>
							{t.problems.retry}
						</button>
						{p.op !== "send" && (
							<button type="button" className="btn btn-sm btn-quiet" onClick={() => act(() => api.dismissProblem(accountId, p.id))}>
								{t.problems.dismiss}
							</button>
						)}
					</li>
				))}
			</ul>
		</details>
	);
}
