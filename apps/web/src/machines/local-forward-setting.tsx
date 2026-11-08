// On a machine's page: whether Localman may send requests to localhost on
// the machine (on by default once the machine runs a tunelo that can). The
// switch goes to the machine over the encrypted link (MachineSettingsSet);
// the machine answers with its info, so the page shows what it now holds.
// Shown only when the machine reports the setting (older tunelo does not).
import { useState } from "react";
import type { MachineSettings } from "@achoo254/chat-proto/remote/remote";
import { Switch, useDomId } from "../messaging/ui/parts.tsx";
import type { MachineLink } from "./link/machine-link.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

interface LocalForwardSettingProps {
	link: Pick<MachineLink, "request">;
	settings: MachineSettings;
	online: boolean;
}

export function LocalForwardSetting({ link, settings, online }: LocalForwardSettingProps) {
	const t = useMachinesCopy().localForward;
	const noteId = useDomId("local-forward");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const on = settings.localForward;

	const change = (next: boolean) => {
		setBusy(true);
		setError("");
		link.request({ case: "machineSettingsSet", value: { localForward: next } }).then(
			() => setBusy(false),
			() => {
				setBusy(false);
				setError(t.failed);
			},
		);
	};

	return (
		<section className="card pad mx-card">
			<h3>{t.title}</h3>
			<div className="mx-setting">
				<span>{t.label}</span>
				<Switch checked={on} label={t.label} describedBy={noteId} disabled={busy || !online} onChange={change} />
			</div>
			<p className="note" id={noteId}>
				{on ? t.onNote : t.offNote}
			</p>
			{on && !settings.localForwardAvailable && (
				<p className="note" role="note">
					{t.unavailable}
				</p>
			)}
			{error !== "" && (
				<p className="mx-error" role="alert">
					{error}
				</p>
			)}
		</section>
	);
}
