// The controls of the "Hiệu quả" page: a switch per usage rule (the machine
// keeps them and writes each change to its consent log) and deleting the
// machine's ledger, asked in the page itself (never a browser dialog).
import { useEffect, useState } from "react";
import type { UsageRuleSwitch } from "@achoo254/chat-proto/remote/remote";
import { machineErrorText } from "../machine-errors.ts";
import { useMachinesCopy } from "../use-machines-copy.ts";
import { ask, type WsLink } from "../workspace/ws-client.ts";
import { ruleCopy } from "./usage-format.ts";

type Switches = { readonly rules: readonly UsageRuleSwitch[] } | { readonly error: string } | null;

/** One switch per rule the machine knows; a change reloads the report through `onChanged`. */
export function RuleSwitches({ link, ai, onChanged }: { link: WsLink; ai: string; onChanged: () => void }) {
	const t = useMachinesCopy();
	const u = t.usage;
	const [switches, setSwitches] = useState<Switches>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	useEffect(() => {
		let current = true;
		ask(link, { case: "usageSettingsGet", value: {} }, "usageSettings").then(
			(settings) => current && setSwitches({ rules: settings.rules }),
			(err: unknown) => current && setSwitches({ error: machineErrorText(t, err, ai) }),
		);
		return () => {
			current = false;
		};
	}, [link, t, ai]);
	const toggle = (rule: UsageRuleSwitch) => {
		setBusy(true);
		setError("");
		ask(link, { case: "usageSettingsSet", value: { rules: [{ rule: rule.rule, enabled: !rule.enabled }] } }, "usageSettings").then(
			(settings) => {
				setBusy(false);
				setSwitches({ rules: settings.rules });
				onChanged();
			},
			() => {
				setBusy(false);
				setError(u.settingsFailed);
			},
		);
	};
	return (
		<section className="mx-card" aria-labelledby="usage-rules-title" data-id="usage-rules">
			<h3 id="usage-rules-title">{u.settingsTitle}</h3>
			<p className="note">{u.settingsNote}</p>
			{switches === null && <p className="note">{u.loading}</p>}
			{switches !== null && "error" in switches && (
				<p className="mx-error" role="alert">
					{switches.error}
				</p>
			)}
			{switches !== null && "rules" in switches && (
				<ul className="mx-usage-switches">
					{switches.rules.map((r) => (
						<li key={r.rule}>
							<label>
								<input type="checkbox" checked={r.enabled} disabled={busy} onChange={() => toggle(r)} data-id={`usage-rule-${r.rule}`} />
								<span>{ruleCopy(u, r.rule).name}</span>
								{r.experimental && <span className="mx-tag">{u.experimental}</span>}
							</label>
						</li>
					))}
				</ul>
			)}
			{error !== "" && (
				<p className="mx-error" role="alert">
					{error}
				</p>
			)}
		</section>
	);
}

type DeleteStep = "idle" | "ask" | "busy" | "done";

/** "Xoá sổ…", then a confirmation in the page; `onDeleted` reloads the report. */
export function DeleteLedger({ link, ai, onDeleted }: { link: WsLink; ai: string; onDeleted: () => void }) {
	const t = useMachinesCopy();
	const u = t.usage;
	const [step, setStep] = useState<DeleteStep>("idle");
	const [error, setError] = useState("");
	const remove = () => {
		setStep("busy");
		setError("");
		ask(link, { case: "usageDelete", value: {} }, "ack").then(
			() => {
				setStep("done");
				onDeleted();
			},
			(err: unknown) => {
				setStep("ask");
				setError(machineErrorText(t, err, ai));
			},
		);
	};
	return (
		<section className="mx-card" aria-labelledby="usage-delete-title" data-id="usage-delete">
			<h3 id="usage-delete-title">{u.deleteTitle}</h3>
			<p className="note">{u.deleteNote}</p>
			{step === "ask" || step === "busy" ? (
				<div className="mx-warn" role="group" aria-label={u.deleteTitle}>
					<p>{u.deleteAsk}</p>
					<div className="mx-usage-actions">
						<button type="button" className="btn btn-sm danger-outline" disabled={step === "busy"} aria-busy={step === "busy"} onClick={remove} data-id="usage-delete-confirm">
							{u.deleteYes}
						</button>
						<button type="button" className="btn btn-sm" disabled={step === "busy"} onClick={() => setStep("idle")}>
							{u.cancel}
						</button>
					</div>
				</div>
			) : (
				<div className="mx-usage-actions">
					<button type="button" className="btn btn-sm danger-outline" onClick={() => setStep("ask")} data-id="usage-delete-btn">
						{u.delete}
					</button>
					{step === "done" && (
						<span className="note" role="status">
							{u.deleted}
						</span>
					)}
				</div>
			)}
			{error !== "" && (
				<p className="mx-error" role="alert">
					{error}
				</p>
			)}
		</section>
	);
}
