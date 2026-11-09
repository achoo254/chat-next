// The AI asks for a sign-in secret (request_secret of tunelo's MCP). The card
// sits above the composer, outside the transcript: nothing typed here enters
// the session's history. It names the site (its domain stands out, so a
// look-alike is easier to spot), the name the AI gave and why it wants it.
// The value goes to the machine in one end-to-end encrypted frame; the field
// is emptied as soon as it is sent and this page keeps no copy of it.
import { useRef, useState, type FormEvent } from "react";
import type { SecretPrompt } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../../components/screen-icons.tsx";
import { useDomId } from "../../messaging/ui/parts.tsx";
import { errorText } from "../use-machines.ts";
import { useMachinesCopy } from "../use-machines-copy.ts";

/** The machine takes at most this many characters. */
export const SECRET_MAX = 4096;

/** The site split for showing: scheme and port quiet, host bold. */
export function originParts(origin: string): { scheme: string; host: string; port: string } {
	try {
		const url = new URL(origin);
		return { scheme: `${url.protocol}//`, host: url.hostname, port: url.port ? `:${url.port}` : "" };
	} catch {
		return { scheme: "", host: origin, port: "" };
	}
}

export function Origin({ origin }: { origin: string }) {
	const { scheme, host, port } = originParts(origin);
	return (
		<span className="mx-origin mono">
			<span className="muted">{scheme}</span>
			<strong>{host}</strong>
			<span className="muted">{port}</span>
		</span>
	);
}

interface SecretCardProps {
	prompt: SecretPrompt;
	ai: string;
	onProvide: (value: string, remember: boolean) => Promise<void>;
	onDecline: () => Promise<void>;
}

export function SecretCard({ prompt, ai, onProvide, onDecline }: SecretCardProps) {
	const t = useMachinesCopy();
	const s = t.secrets;
	const id = useDomId("secret");
	const field = useRef<HTMLInputElement>(null);
	const [value, setValue] = useState("");
	const [shown, setShown] = useState(false);
	const [remember, setRemember] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const expires = new Date(Number(prompt.expiresAt)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

	const forget = () => {
		setValue("");
		setShown(false);
		if (field.current) field.current.value = "";
	};

	const run = (action: () => Promise<void>) => {
		if (busy) return;
		setBusy(true);
		setError("");
		action().then(
			() => setBusy(false),
			(err: unknown) => {
				setBusy(false);
				setError(errorText(t, err, ai));
			},
		);
	};

	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (value === "") return;
		const sent = value;
		// Out of this page's state at once, whatever the machine answers.
		forget();
		run(() => onProvide(sent, remember));
	};

	return (
		<form className="mx-action mx-secret" aria-labelledby={`${id}-title`} onSubmit={submit} data-id="secret-card">
			<h4 id={`${id}-title`}>
				<Icon name="key" />
				<span>{s.title(ai)}</span>
			</h4>
			<dl className="mx-secret-facts">
				<dt>{s.site}</dt>
				<dd>
					<Origin origin={prompt.origin} />
				</dd>
				<dt>{s.name}</dt>
				<dd className="mono">{prompt.name}</dd>
				{prompt.purpose !== "" && (
					<>
						<dt>{s.purpose}</dt>
						<dd>{prompt.purpose}</dd>
					</>
				)}
			</dl>
			<label className="sr-only" htmlFor={`${id}-value`}>
				{s.value}
			</label>
			<div className="mx-secret-field">
				<input
					id={`${id}-value`}
					ref={field}
					className="input mono"
					type={shown ? "text" : "password"}
					value={value}
					maxLength={SECRET_MAX}
					placeholder={s.value}
					autoComplete="off"
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
					disabled={busy}
					data-id="secret-card-value"
					onChange={(event) => setValue(event.target.value)}
				/>
				<button type="button" className="icon-btn" aria-pressed={shown} aria-label={shown ? s.hide : s.show} onClick={() => setShown((now) => !now)}>
					<Icon name={shown ? "eye-off" : "eye"} />
				</button>
			</div>
			<label className="mx-check">
				<input type="checkbox" checked={remember} disabled={busy} onChange={(event) => setRemember(event.target.checked)} data-id="secret-card-remember" />
				<span>
					{s.remember}
					<small>{s.rememberNote}</small>
				</span>
			</label>
			<p className="note">{s.e2e(ai)}</p>
			<div className="acts">
				<button type="submit" className="btn btn-primary btn-sm" disabled={busy || value === ""} data-id="secret-card-send">
					{s.send}
				</button>
				<button
					type="button"
					className="btn btn-sm danger-outline"
					disabled={busy}
					data-id="secret-card-decline"
					onClick={() => {
						forget();
						run(onDecline);
					}}
				>
					{s.decline}
				</button>
				<span className="muted mx-secret-expires">{s.expires(expires)}</span>
			</div>
			{error !== "" && (
				<p className="mx-error" role="alert">
					{error}
				</p>
			)}
		</form>
	);
}
