// The sending switch of a bridge account whose app sends only once the owner allows
// it (Zalo, the owner's main personal account): off by default. Turning it on asks
// first, with the risk spelled out; turning it off needs no confirmation. Loaded
// only for such an account.
import { useId, useState } from "react";
import { useServices } from "../data/services.tsx";
import { ConfirmDialog } from "../bots/dialogs.tsx";
import { Switch } from "../ui/parts.tsx";
import type { BridgeAccount, BridgeApi } from "./bridge-api.ts";
import { useBridgeCopy } from "./use-bridge-copy.ts";

interface Props {
	readonly account: BridgeAccount;
	readonly api: BridgeApi;
	readonly appName: string;
	readonly onChange: () => void;
}

export function BridgeSendSwitch({ account, api, appName, onChange }: Props) {
	const t = useBridgeCopy();
	const { toasts } = useServices();
	const hintId = useId();
	const [asking, setAsking] = useState(false);
	const [busy, setBusy] = useState(false);
	const set = (enabled: boolean) => {
		setBusy(true);
		api.setSendEnabled(account.id, enabled).then(
			() => {
				setBusy(false);
				setAsking(false);
				toasts.show(enabled ? t.send.on : t.send.off);
				onChange();
			},
			() => {
				setBusy(false);
				toasts.show(t.failed);
			},
		);
	};
	// Only a connected account can start sending; one that is on can always be turned off.
	const locked = busy || (!account.sendEnabled && account.status !== "active");
	return (
		<div className="br-sync" data-id="bridge-send">
			<div className="row">
				<span className="grow br-text">
					<b>{t.send.label(appName)}</b>
					<small className="muted" id={hintId}>
						{t.send.hint}
					</small>
				</span>
				<Switch
					checked={account.sendEnabled}
					label={t.send.label(appName)}
					describedBy={hintId}
					disabled={locked}
					onChange={(on) => (on ? setAsking(true) : set(false))}
				/>
			</div>
			{asking && (
				<ConfirmDialog
					title={t.send.confirm.title(appName)}
					body={
						<ul>
							{t.send.confirm.points(appName).map((point) => (
								<li key={point}>{point}</li>
							))}
						</ul>
					}
					action={t.send.confirm.action}
					busyLabel={t.send.confirm.busy}
					busy={busy}
					danger
					onConfirm={() => set(true)}
					onClose={() => setAsking(false)}
				/>
			)}
		</div>
	);
}
