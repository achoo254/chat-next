// Development only: pair with `tunelo run --port N` on this computer
// (ws://127.0.0.1:N, no server and no tunnel) using the 6-digit code from
// `tunelo pair`, so every screen can be tried end to end locally. The
// route and this page do not exist in production builds (router.tsx).
import { useState } from "react";
import { navigate, paths } from "../router.tsx";
import { LOCAL_REF, setLocalPort } from "./link/link-hub.ts";
import { PageHead } from "./page-head.tsx";
import { CodeInput, pairByCode, pairError } from "./pair-device.tsx";
import { useHub } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

export function LocalMachine() {
	const t = useMachinesCopy();
	const hub = useHub();
	const [port, setPort] = useState("47821");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	if (!import.meta.env.DEV) return null;
	const valid = /^[0-9]{2,5}$/.test(port) && Number(port) < 65536;
	const connect = (code: string) => {
		if (!valid) return;
		setBusy(true);
		setError("");
		setLocalPort(Number(port));
		pairByCode(hub, LOCAL_REF, `ws://127.0.0.1:${port}`, code).then(
			() => navigate(paths.machine(LOCAL_REF)),
			(err: unknown) => {
				setBusy(false);
				setError(pairError(t, err));
			},
		);
	};
	return (
		<div className="mx-scroll">
			<PageHead back={paths.machines()} backLabel={t.backToMachines} title={t.local.title} />
			<div className="mx-body">
				<div className="card pad mx-card narrow">
					<p className="muted">{t.local.hint}</p>
					<label className="mx-field-row">
						<span>{t.local.port}</span>
						<input className="input mono" inputMode="numeric" value={port} onChange={(event) => setPort(event.target.value.trim())} />
					</label>
					<p className="note">{t.local.code}</p>
					<CodeInput disabled={busy || !valid} onCode={connect} />
					{busy && (
						<div className="mx-wait">
							<span className="spin" aria-hidden="true" />
							{t.local.connecting}
						</div>
					)}
					{error !== "" && (
						<p className="mx-error" role="alert">
							{error}
						</p>
					)}
				</div>
			</div>
		</div>
	);
}
