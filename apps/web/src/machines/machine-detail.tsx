// A machine's page: its sessions, the consent log kept on the machine (opening
// sensitive folders, loading project settings, approving sensitive tools,
// pairing and revoking devices), what it runs, this device's pairing, and
// renaming or removing the machine. Removing it or revoking this device
// takes effect at the machine's next heartbeat (about a minute).
import { useEffect, useState, type FormEvent } from "react";
import type { AuditEntry } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../components/screen-icons.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { ConfirmDialog } from "../messaging/bots/dialogs.tsx";
import { DialogHead, Modal, useDomId } from "../messaging/ui/parts.tsx";
import { Link, navigate, paths } from "../router.tsx";
import { LOCAL_REF, setLocalPort } from "./link/link-hub.ts";
import { LinkBanner } from "./link-banner.tsx";
import { PageHead } from "./page-head.tsx";
import { sortForList } from "./link/machine-link.ts";
import { aiName, stateKey, useEntry, useHub, useLink } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

const AUDIT_FIRST = 20;
const AUDIT_ALL = 200;

export function MachineDetail({ machine }: { machine: string }) {
	const t = useMachinesCopy();
	const { locale } = useI18n();
	const hub = useHub();
	const entry = useEntry(hub, machine);
	const [link, state] = useLink(hub, machine);
	const [audit, setAudit] = useState<readonly AuditEntry[] | null>(null);
	const [auditLimit, setAuditLimit] = useState(AUDIT_FIRST);
	const [dialog, setDialog] = useState<"rename" | "remove" | "revoke" | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const online = state.status.kind === "open";
	const name = entry?.name ?? "";
	const local = machine === LOCAL_REF;

	useEffect(() => {
		if (!online) return;
		let active = true;
		link.request({ case: "auditList", value: { limit: auditLimit } }).then(
			(frame) => {
				if (active && frame.body.case === "auditListResult") setAudit(frame.body.value.entries);
			},
			() => undefined,
		);
		return () => {
			active = false;
		};
	}, [link, online, auditLimit]);

	const act = (run: () => Promise<void>, done: () => void) => {
		setBusy(true);
		setError("");
		run().then(
			() => {
				setBusy(false);
				setDialog(null);
				done();
			},
			() => {
				setBusy(false);
				setError(t.errors.generic);
			},
		);
	};
	const remove = () =>
		act(
			async () => {
				if (local) setLocalPort(null);
				else if (entry !== null) await hub.deps.directory.remove(entry.id);
				await hub.forget(machine);
				await hub.refresh().catch(() => undefined);
			},
			() => navigate(paths.machines()),
		);
	const revokeThis = () =>
		act(
			async () => {
				if (entry === null) return;
				const device = await hub.deps.keys.device();
				await hub.deps.directory.revokeDevice(entry.id, device.publicKey);
				await hub.forget(machine);
			},
			() => navigate(paths.machines()),
		);

	if (entry === null) {
		return (
			<div className="mx-scroll">
				<PageHead back={paths.machines()} backLabel={t.backToMachines} title={t.title} />
				<div className="mx-body">
					<p className="muted">{hub.directory().status === "loading" ? "" : t.notFound}</p>
				</div>
			</div>
		);
	}
	const claude = providerVersion(state);
	return (
		<div className="mx-scroll">
			<PageHead
				back={paths.machine(machine)}
				backLabel={t.sessions.label(name)}
				title={name}
				subtitle={entry.os === "" ? entry.tunnelUrl : t.os(entry.os, entry.arch)}
			/>
			<LinkBanner machine={machine} name={name} status={state.status} />
			<div className="mx-body">
				<section className="card pad mx-card">
					<h3>{t.detail.sessions}</h3>
					{!online && <p className="muted">{t.detail.needsLink}</p>}
					{online && state.listed && state.threads.length === 0 && <p className="muted">{t.detail.noSessions}</p>}
					{sortForList(state.threads).map((thread) => (
						<Link key={thread.id} to={paths.machineSession(machine, thread.id)} className="mx-session-row">
							<span>
								<b>{thread.title}</b>
								<span className="mono muted">{thread.dir}</span>
							</span>
							<span className={`chip mx-chip ${stateKey(thread)}`}>{t.sessions.state[stateKey(thread)]}</span>
						</Link>
					))}
				</section>
				<section className="card pad mx-card">
					<h3>{t.detail.audit}</h3>
					<p className="note">{t.detail.auditNote(name)}</p>
					{online && audit !== null && audit.length === 0 && <p className="muted">{t.detail.auditEmpty}</p>}
					{audit !== null && audit.length > 0 && (
						<ul className="mx-audit">
							{audit.map((e, i) => (
								<li key={`${e.at}:${i}`}>
									<time dateTime={new Date(Number(e.at)).toISOString()}>
										{new Date(Number(e.at)).toLocaleString(locale, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
									</time>
									<span>
										{e.device} {t.detail.auditActions[e.action] ?? e.action}
										{e.path !== "" && (
											<>
												{" "}
												<span className="mono">{e.path}</span>
											</>
										)}
										{e.action === "approve_sensitive" && e.detail !== "" && <span className="mono"> · {e.detail}</span>}
									</span>
								</li>
							))}
						</ul>
					)}
					{audit !== null && audit.length >= auditLimit && auditLimit < AUDIT_ALL && (
						<div>
							<button type="button" className="btn btn-sm" onClick={() => setAuditLimit(AUDIT_ALL)}>
								{t.detail.auditAll}
							</button>
						</div>
					)}
				</section>
				<section className="card pad mx-card">
					<h3>{t.detail.about}</h3>
					<dl className="mx-kv">
						{entry.os !== "" && (
							<>
								<dt>{t.detail.os}</dt>
								<dd>{t.os(entry.os, entry.arch)}</dd>
							</>
						)}
						{(claude !== null || entry.claudeVersion !== "") && (
							<>
								<dt>{claude?.name ?? t.detail.claude}</dt>
								<dd className="mono">
									{claude?.version ?? entry.claudeVersion}{" "}
									{claude !== null && (
										<span className={claude.untested ? "chip mx-chip warn" : "chip mx-chip ok"}>{claude.untested ? t.detail.untested : t.detail.tested}</span>
									)}
								</dd>
							</>
						)}
						<dt>{t.detail.agent}</dt>
						<dd className="mono">chat-agent {state.info?.agentVersion || entry.agentVersion || "—"}</dd>
						<dt>{t.detail.devices}</dt>
						<dd className="mx-devices">
							<span>
								{hub.deps.deviceName} ({t.detail.thisDevice}){" "}
								{!local && (
									<button type="button" className="btn btn-sm btn-danger" onClick={() => setDialog("revoke")}>
										{t.detail.revokeThis}
									</button>
								)}
							</span>
							<span className="note">{t.detail.pairNewHint}</span>
						</dd>
					</dl>
					<div className="acts">
						{!local && (
							<button type="button" className="btn btn-sm" onClick={() => setDialog("rename")}>
								<Icon name="edit" small />
								{t.detail.rename}
							</button>
						)}
						<button type="button" className="btn btn-sm danger-outline" onClick={() => setDialog("remove")}>
							<Icon name="trash" small />
							{t.detail.remove}
						</button>
					</div>
					{error !== "" && dialog === null && (
						<p className="mx-error" role="alert">
							{error}
						</p>
					)}
				</section>
			</div>
			{dialog === "remove" && (
				<ConfirmDialog
					title={t.detail.removeTitle(name)}
					body={<p>{t.detail.removeBody}</p>}
					action={t.detail.remove}
					busyLabel={t.detail.removing}
					busy={busy}
					danger
					onConfirm={remove}
					onClose={() => setDialog(null)}
				/>
			)}
			{dialog === "revoke" && (
				<ConfirmDialog
					title={t.detail.revokeTitle}
					body={<p>{t.detail.revokeBody(name)}</p>}
					action={t.detail.revokeThis}
					busyLabel={t.detail.revoking}
					busy={busy}
					danger
					onConfirm={revokeThis}
					onClose={() => setDialog(null)}
				/>
			)}
			{dialog === "rename" && (
				<RenameDialog
					current={name}
					busy={busy}
					error={error}
					onSave={(next) =>
						act(
							async () => {
								await hub.deps.directory.rename(entry.id, next);
								await hub.refresh();
							},
							() => undefined,
						)
					}
					onClose={() => setDialog(null)}
				/>
			)}
		</div>
	);
}

function providerVersion(state: ReturnType<typeof useLink>[1]): { name: string; version: string; untested: boolean } | null {
	const p = state.info?.providers[0];
	return p === undefined ? null : { name: aiName(state.info, p.id), version: p.version, untested: p.untestedVersion };
}

function RenameDialog({ current, busy, error, onSave, onClose }: { current: string; busy: boolean; error: string; onSave: (name: string) => void; onClose: () => void }) {
	const t = useMachinesCopy();
	const id = useDomId("rename");
	const [name, setName] = useState(current);
	const trimmed = name.trim();
	const valid = trimmed.length >= 1 && [...trimmed].length <= 64;
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (valid) onSave(trimmed);
	};
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={t.detail.renameTitle} onClose={onClose} />
			<form onSubmit={submit}>
				<div className="dlg-body stack">
					<label className="mx-field-row">
						<span>{t.detail.name}</span>
						<input className="input" value={name} maxLength={64} aria-invalid={!valid} onChange={(event) => setName(event.target.value)} />
					</label>
					{!valid && <p className="mx-error">{t.detail.nameInvalid}</p>}
					{error !== "" && (
						<p className="mx-error" role="alert">
							{error}
						</p>
					)}
				</div>
				<div className="dlg-foot">
					<button type="button" className="btn" onClick={onClose}>
						{t.newSession.cancel}
					</button>
					<button type="submit" className="btn btn-primary" disabled={busy || !valid}>
						{busy ? t.detail.saving : t.detail.save}
					</button>
				</div>
			</form>
		</Modal>
	);
}

