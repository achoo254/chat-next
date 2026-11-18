// Settings › Cố vấn › Khoá TypeSafe: one key for the account, pasted once on
// one machine (AdvisorSetKey with source ACCOUNT) and handed on from machine
// to machine (use-advisor-key-sync.ts), removed from every machine at once
// (AdvisorProfile.key_removed_at, then AdvisorRemoveKey with source ACCOUNT);
// a machine's key kept from before is offered once as the account's
// (AdvisorKeyPromote); under it, each machine with its own key or the
// account's. The key goes to a machine end-to-end encrypted and never comes
// back; the section is never offered to Advisor's copy chip
// (data-advisor-ignore). The only place in the app that names Jev and TypeSafe.
import { useEffect, useState } from "react";
import { AdvisorKeySource } from "@achoo254/chat-proto/remote/remote";
import { useI18n } from "../../i18n/i18n.tsx";
import { useAdvisorProfile, useAdvisorProfileLoaded, useServices } from "../../messaging/data/services.tsx";
import { useHub, useMachineViews, useNow } from "../../machines/use-machines.ts";
import { IGNORE_ATTR } from "../../advisor/advisor-context.tsx";
import { nextSetAt, planKeySync, removalTime, shareMachines, type KeyMachine } from "../../advisor/advisor-account-key.ts";
import { useAdvisorCopy } from "../../advisor/use-advisor-copy.ts";
import { ConfirmRemove, KeyError, KeyForm, useKeyRequest } from "./advisor-key-form.tsx";
import { MachineKeyRow } from "./advisor-machine-key-row.tsx";

/** Each machine's key, from its MachineInfo.advisor (links open only to machines online), and the account's key across them. */
export function KeySection() {
	const t = useAdvisorCopy();
	const hub = useHub();
	const now = useNow();
	const views = useMachineViews(hub, now);
	const loaded = useAdvisorProfileLoaded();
	const removedAt = useAdvisorProfile().keyRemovedAt;
	useEffect(() => {
		hub.device().catch(() => undefined);
		if (hub.directory().status !== "ready") hub.refresh().catch(() => undefined);
	}, [hub]);
	const machines = shareMachines(views);
	const account = planKeySync(views, removedAt).source;
	// A key kept from before the account's key: offered once as the account's, never after a removal.
	const legacy = loaded && removedAt === 0 && machines.every((m) => m.key.source !== "account") ? machines.find((m) => m.key.source === "own") : undefined;
	return (
		<div className="card" data-id="advisor-keys" {...{ [IGNORE_ATTR]: "" }}>
			<h2 className="card-title">{t.key.title}</h2>
			<p className="note pad-x">{t.key.model}</p>
			{views.every((view) => view.state.info?.advisor?.keySet !== true) && <KeyGuide />}
			<AccountKeyRow machines={machines} account={account} removedAt={removedAt} loaded={loaded} />
			{legacy !== undefined && <PromoteBar machine={legacy} machines={machines} removedAt={removedAt} />}
			{views.length === 0 ? <p className="note pad-x">{t.key.none}</p> : views.map((view) => <MachineKeyRow key={view.entry.ref} view={view} />)}
		</div>
	);
}

/** Steps for someone with no TypeSafe key yet; shown while no machine of the account has one. */
function KeyGuide() {
	const { key } = useAdvisorCopy();
	const { guide } = key;
	return (
		<div className="adv-key-guide pad-x" data-id="advisor-key-guide">
			<strong>{guide.title}</strong>
			<ol>
				{guide.steps.map((step) => (
					<li key={step}>{step}</li>
				))}
			</ol>
			<a className="btn btn-sm" href={guide.consoleUrl} target="_blank" rel="noopener noreferrer">
				{guide.open}
			</a>
			<p className="note">{guide.notRunning}</p>
		</div>
	);
}

/** The account's key: its fingerprint, paste a new one, remove it from every machine. */
function AccountKeyRow({ machines, account, removedAt, loaded }: { machines: readonly KeyMachine[]; account: KeyMachine | null; removedAt: number; loaded: boolean }) {
	const t = useAdvisorCopy();
	const { locale } = useI18n();
	const { store } = useServices();
	const [mode, setMode] = useState<"view" | "paste" | "remove">("view");
	const { busy, error, setError, run } = useKeyRequest();
	const back = () => setMode("view");
	const paste = (value: string) => {
		// The machine that holds the account's key now, else one without a key; never one with its own.
		const target = machines.find((m) => m.key.source === "account") ?? machines.find((m) => m.key.source === "none");
		if (target === undefined) return setError(t.key.account.noMachine);
		const setAt = BigInt(nextSetAt(Date.now(), removedAt, machines));
		run(() => target.view.link.request({ case: "advisorSetKey", value: { key: value, source: AdvisorKeySource.ACCOUNT, setAt } }), back);
	};
	const remove = () =>
		run(async () => {
			// The removal time first: a machine missed now (off, a failed request) is cleaned when a device next links to it.
			await store.setAdvisorProfile({ keyRemovedAt: removalTime(Date.now(), machines) });
			const holders = machines.filter((m) => m.key.source === "account");
			await Promise.allSettled(holders.map((m) => m.view.link.request({ case: "advisorRemoveKey", value: { source: AdvisorKeySource.ACCOUNT } })));
		}, back);
	const key = account?.key;
	const setBy =
		key !== undefined && key.setByDevice !== ""
			? t.key.setBy(key.setByDevice === "local" ? t.key.localDevice : key.setByDevice, new Date(key.setAt).toLocaleString(locale))
			: "";
	return (
		<div className="adv-machine-key pad-x" data-id="advisor-account-key">
			<div className="row">
				<span className="grow">
					<strong>{key !== undefined ? t.key.account.set(key.fingerprint) : t.key.account.none}</strong>
					{setBy !== "" && <small>{setBy}</small>}
				</span>
				{loaded && mode === "view" && (
					<span className="adv-acts">
						<button type="button" className="btn btn-sm" onClick={() => setMode("paste")}>
							{t.key.paste}
						</button>
						{key !== undefined && (
							<button type="button" className="btn btn-sm" onClick={() => setMode("remove")}>
								{t.key.remove}
							</button>
						)}
					</span>
				)}
			</div>
			{mode === "paste" && <KeyForm busy={busy} cancel={back} send={paste} />}
			{mode === "remove" && <ConfirmRemove text={t.key.confirmRemove} action={t.key.remove} busy={busy} cancel={back} confirm={remove} />}
			<KeyError error={error} />
		</div>
	);
}

/** Offers a machine's key kept from before as the account's; the user agrees once (AdvisorKeyPromote) or puts it off. */
function PromoteBar({ machine, machines, removedAt }: { machine: KeyMachine; machines: readonly KeyMachine[]; removedAt: number }) {
	const t = useAdvisorCopy();
	const [later, setLater] = useState(false);
	const { busy, error, run } = useKeyRequest();
	if (later) return null;
	const promote = () =>
		run(
			() => machine.view.link.request({ case: "advisorKeyPromote", value: { setAt: BigInt(nextSetAt(Date.now(), removedAt, machines)) } }),
			() => undefined,
		);
	return (
		<div className="adv-machine-key pad-x" role="status" data-id="advisor-key-promote">
			<div className="row">
				<span className="grow">{t.key.account.promote(machine.view.entry.name)}</span>
				<span className="adv-acts">
					<button type="button" className="btn btn-sm" onClick={() => setLater(true)}>
						{t.key.account.later}
					</button>
					<button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={promote}>
						{t.key.account.promoteYes}
					</button>
				</span>
			</div>
			<KeyError error={error} />
		</div>
	);
}
