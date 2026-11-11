// "Refresh the machine's status": asks the directory again and reconnects the
// link, so a page that shows a stale state (not paired, offline, retrying)
// reads the machine's latest one without a reload of the whole app.
import { useState, type ReactElement } from "react";
import { Icon } from "../components/screen-icons.tsx";
import { useHub } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

export function RefreshMachine({ machine }: { machine: string }): ReactElement {
	const t = useMachinesCopy();
	const hub = useHub();
	const [busy, setBusy] = useState(false);
	const refresh = () => {
		setBusy(true);
		hub
			.reload(machine)
			.catch(() => undefined)
			.finally(() => setBusy(false));
	};
	return (
		<button type="button" className="icon-btn" data-id="machine-refresh" aria-label={t.link.refresh} title={t.link.refresh} disabled={busy} onClick={refresh}>
			{busy ? <span className="spin" aria-hidden="true" /> : <Icon name="refresh" />}
		</button>
	);
}
