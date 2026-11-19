// Account-wide tools of the bridge: the one place that lists everything Chat sent to the
// other app that did not go through, whatever the feature. Loaded when the account page opens.
import { useEffect, useState } from "react";
import type { BridgeApi, BridgeError, BridgeProblem } from "./bridge-api.ts";
import { useBridgeCopy } from "./use-bridge-copy.ts";

interface Props {
	readonly accountId: number;
	readonly api: BridgeApi;
	readonly onChange: () => void;
	readonly onError: (err: unknown) => BridgeError;
}

export function BridgeAccountTools(props: Props) {
	return (
		<div className="br-tools" data-id="bridge-account-tools">
			<Problems {...props} />
		</div>
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
