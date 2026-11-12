// Development only: reach `tunelo run --port N` on this computer
// (ws://127.0.0.1:N, no tunnel), so every screen can be tried end to end
// locally. That tunelo signed in to this account (tunelo login), so it is one
// of the directory's machines: picking it gives the link the key the account
// lists for it, and the machine accepts this device like any other device of
// the account. The route and this page do not exist in production builds
// (router.tsx).
import { useEffect, useState, type FormEvent } from "react";
import { navigate, paths } from "../router.tsx";
import { LOCAL_REF, localMachine, setLocalMachine } from "./link/link-hub.ts";
import { PageHead } from "./page-head.tsx";
import { useDirectory, useHub } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

export function LocalMachine() {
	const t = useMachinesCopy();
	const hub = useHub();
	const directory = useDirectory(hub);
	const saved = localMachine();
	const [port, setPort] = useState(String(saved?.port ?? 47821));
	const [machineId, setMachineId] = useState(saved?.machineId ?? 0);
	useEffect(() => {
		hub.refresh().catch(() => undefined);
	}, [hub]);
	if (!import.meta.env.DEV) return null;
	const machines = directory.machines;
	const chosen = machines.some((m) => m.id === machineId) ? machineId : (machines[0]?.id ?? 0);
	const valid = /^[0-9]{2,5}$/.test(port) && Number(port) < 65536 && chosen > 0;
	const connect = (event: FormEvent) => {
		event.preventDefault();
		if (!valid) return;
		setLocalMachine({ port: Number(port), machineId: chosen });
		void hub.reload(LOCAL_REF).catch(() => undefined);
		navigate(paths.machine(LOCAL_REF));
	};
	return (
		<div className="mx-scroll">
			<PageHead back={paths.machines()} backLabel={t.backToMachines} title={t.local.title} />
			<div className="mx-body">
				<form className="card pad mx-card narrow" onSubmit={connect}>
					<p className="muted">{t.local.hint}</p>
					<label className="mx-field-row">
						<span>{t.local.port}</span>
						<input className="input mono" inputMode="numeric" value={port} onChange={(event) => setPort(event.target.value.trim())} />
					</label>
					{machines.length === 0 ? (
						<p className="note">{directory.status === "loading" ? "" : t.local.noMachines}</p>
					) : (
						<label className="mx-field-row">
							<span>{t.local.machine}</span>
							<select className="input" value={chosen} onChange={(event) => setMachineId(Number(event.target.value))}>
								{machines.map((m) => (
									<option key={m.id} value={m.id}>
										{m.name}
									</option>
								))}
							</select>
						</label>
					)}
					<div className="acts">
						<button type="submit" className="btn btn-primary" disabled={!valid}>
							{t.local.connect}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}
