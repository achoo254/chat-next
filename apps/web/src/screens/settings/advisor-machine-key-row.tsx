// One machine in Settings › Cố vấn › Khoá TypeSafe: whose key it uses (the
// account's, its own, none), its fingerprint, which device set it and when,
// and its own key, pasted or removed for this machine only (AdvisorSetKey and
// AdvisorRemoveKey with source OWN). A machine on an older tunelo keeps the
// one key it knows and says it needs a newer tunelo for the account's key.
import { useState } from "react";
import { AdvisorKeySource } from "@achoo254/chat-proto/remote/remote";
import { useI18n } from "../../i18n/i18n.tsx";
import type { MachineView } from "../../machines/use-machines.ts";
import { keyStateOf, type MachineKeyState } from "../../advisor/advisor-account-key.ts";
import { useAdvisorCopy } from "../../advisor/use-advisor-copy.ts";
import type { AdvisorCopy } from "../../advisor/copy-vi.ts";
import { ConfirmRemove, KeyError, KeyForm, useKeyRequest } from "./advisor-key-form.tsx";

/** What the row says about the machine's key. */
function statusOf(t: AdvisorCopy, view: MachineView, key: MachineKeyState): string {
	const info = view.state.info;
	const advisor = info?.advisor;
	if (view.state.status.kind !== "open") return view.conn.kind === "offline" ? t.key.offline : t.ask.connecting;
	if (info === null) return t.ask.connecting;
	if (advisor === undefined) return t.key.update;
	if (!advisor.available) return t.key.mcpOff;
	if (key.source === "none") return t.key.noKey;
	if (!key.share) return t.key.keySet(key.fingerprint);
	return key.source === "account" ? t.key.usingAccount(key.fingerprint) : t.key.own(key.fingerprint);
}

export function MachineKeyRow({ view }: { view: MachineView }) {
	const t = useAdvisorCopy();
	const { locale } = useI18n();
	const [mode, setMode] = useState<"view" | "paste" | "remove">("view");
	const { busy, error, run } = useKeyRequest();
	const key = keyStateOf(view);
	const back = () => setMode("view");
	const setBy =
		key.source !== "none" && key.setByDevice !== ""
			? t.key.setBy(key.setByDevice === "local" ? t.key.localDevice : key.setByDevice, new Date(key.setAt).toLocaleString(locale))
			: "";
	// A key on an older tunelo is the machine's own: it is the one it can remove.
	const hasOwn = key.source === "own";
	return (
		<div className="adv-machine-key pad-x" data-id={`advisor-key-${view.entry.ref}`}>
			<div className="row">
				<span className="grow">
					{view.entry.name}
					<small>{statusOf(t, view, key)}</small>
					{setBy !== "" && <small>{setBy}</small>}
					{key.reachable && !key.share && <small>{t.key.needsShare}</small>}
				</span>
				{key.reachable && mode === "view" && (
					<span className="adv-acts">
						<button type="button" className="btn btn-sm" onClick={() => setMode("paste")}>
							{t.key.pasteOwn}
						</button>
						{hasOwn && (
							<button type="button" className="btn btn-sm" onClick={() => setMode("remove")}>
								{t.key.removeOwn}
							</button>
						)}
					</span>
				)}
			</div>
			{mode === "paste" && (
				<KeyForm
					busy={busy}
					cancel={back}
					send={(value) => run(() => view.link.request({ case: "advisorSetKey", value: { key: value, source: AdvisorKeySource.OWN } }), back)}
				/>
			)}
			{mode === "remove" && (
				<ConfirmRemove
					text={t.key.confirmRemoveOwn}
					action={t.key.removeOwn}
					busy={busy}
					cancel={back}
					confirm={() => run(() => view.link.request({ case: "advisorRemoveKey", value: { source: AdvisorKeySource.OWN } }), back)}
				/>
			)}
			<KeyError error={error} />
		</div>
	);
}
