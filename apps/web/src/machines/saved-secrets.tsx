// On a machine's page: the sign-in secrets the machine keeps for the AI, by
// site and name, with their last use. Values never leave the machine, so
// they never show here. Removing one goes to the machine over the encrypted
// link (SecretRemove), which answers with the list it now keeps. Shown only
// for machines that keep secrets (MachineInfo.secrets, tunelo 2.0.8+).
import { useCallback, useEffect, useState } from "react";
import type { Frame, SavedSecret } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../components/screen-icons.tsx";
import { Origin } from "./cards/secret-request.tsx";
import type { MachineLink } from "./link/machine-link.ts";
import { errorText, timeAgo, useNow } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

interface SavedSecretsProps {
	link: Pick<MachineLink, "request">;
	online: boolean;
	ai: string;
}

function listOf(frame: Frame): readonly SavedSecret[] | null {
	return frame.body.case === "secretListResult" ? frame.body.value.secrets : null;
}

export function SavedSecrets({ link, online, ai }: SavedSecretsProps) {
	const t = useMachinesCopy();
	const s = t.secrets;
	const now = useNow();
	const [secrets, setSecrets] = useState<readonly SavedSecret[] | null>(null);
	const [busy, setBusy] = useState("");
	const [error, setError] = useState("");

	const load = useCallback(() => {
		link.request({ case: "secretList", value: {} }).then(
			(frame) => setSecrets(listOf(frame)),
			(err: unknown) => setError(errorText(t, err, ai)),
		);
	}, [link, t, ai]);

	useEffect(() => {
		if (online) load();
	}, [online, load]);

	const remove = (id: string) => {
		setBusy(id);
		setError("");
		link.request({ case: "secretRemove", value: { id } }).then(
			(frame) => {
				setBusy("");
				setSecrets(listOf(frame));
			},
			(err: unknown) => {
				setBusy("");
				setError(errorText(t, err, ai));
			},
		);
	};

	return (
		<section className="card pad mx-card" data-id="saved-secrets">
			<h3>{s.savedTitle}</h3>
			<p className="note">{s.savedNote}</p>
			{secrets !== null && secrets.length === 0 && <p className="muted">{s.savedEmpty}</p>}
			{secrets !== null && secrets.length > 0 && (
				<ul className="mx-secrets-list">
					{secrets.map((x) => (
						<li key={x.id} data-id={`saved-secrets-${x.id}`}>
							<Icon name="key" />
							<span className="mx-secret-what">
								<Origin origin={x.origin} />
								<span className="mono">{x.name}</span>
								<small>{x.lastUsedAt > 0n ? s.lastUsed(timeAgo(t, Number(x.lastUsedAt), now)) : s.neverUsed}</small>
							</span>
							<button
								type="button"
								className="btn btn-sm danger-outline"
								disabled={!online || busy !== ""}
								aria-label={s.removeLabel(x.name, x.origin)}
								onClick={() => remove(x.id)}
							>
								<Icon name="trash" />
								{s.remove}
							</button>
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
