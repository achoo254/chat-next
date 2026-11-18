// The pieces both key rows of Settings › Cố vấn share: the field a key is
// pasted into (a password field, never stored, cleared once sent), the
// confirmation before a removal, and a request's busy and error state.
import { useState, type FormEvent } from "react";
import { errorText } from "../../machines/use-machines.ts";
import { useMachinesCopy } from "../../machines/use-machines-copy.ts";
import { useAdvisorCopy } from "../../advisor/use-advisor-copy.ts";

/** A request's state: busy while it runs, the machine's refusal in the user's words after. */
export function useKeyRequest(): {
	busy: boolean;
	error: string;
	setError: (error: string) => void;
	run: (request: () => Promise<unknown>, done: () => void) => void;
} {
	const t = useAdvisorCopy();
	const tm = useMachinesCopy();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const run = (request: () => Promise<unknown>, done: () => void) => {
		setBusy(true);
		setError("");
		request()
			.then(done)
			.catch((err: unknown) => setError(errorText(tm, err, "AI") || t.key.failed))
			.finally(() => setBusy(false));
	};
	return { busy, error, setError, run };
}

/** The field a key is pasted into; `send` gets the trimmed key and the field empties at once (the page keeps no copy). */
export function KeyForm({ busy, send, cancel }: { busy: boolean; send: (key: string) => void; cancel: () => void }) {
	const t = useAdvisorCopy();
	const [key, setKey] = useState("");
	const submit = (event: FormEvent) => {
		event.preventDefault();
		const value = key.trim();
		if (value === "") return;
		setKey("");
		send(value);
	};
	return (
		<form className="adv-key-form" onSubmit={submit}>
			<input
				className="input"
				type="password"
				autoComplete="off"
				spellCheck={false}
				aria-label={t.key.field}
				placeholder={t.key.field}
				maxLength={4096}
				value={key}
				onChange={(event) => setKey(event.target.value)}
			/>
			<span className="adv-acts">
				<button type="button" className="btn btn-sm" onClick={cancel}>
					{t.key.cancel}
				</button>
				<button type="submit" className="btn btn-sm btn-primary" disabled={busy || key.trim() === ""}>
					{t.key.save}
				</button>
			</span>
		</form>
	);
}

/** Asks before a key is removed. */
export function ConfirmRemove({ text, action, busy, confirm, cancel }: { text: string; action: string; busy: boolean; confirm: () => void; cancel: () => void }) {
	const t = useAdvisorCopy();
	return (
		<div className="adv-key-form" role="alert">
			<p>{text}</p>
			<span className="adv-acts">
				<button type="button" className="btn btn-sm" onClick={cancel}>
					{t.key.cancel}
				</button>
				<button type="button" className="btn-danger-text" disabled={busy} onClick={confirm}>
					{action}
				</button>
			</span>
		</div>
	);
}

/** A refusal under a row. */
export function KeyError({ error }: { error: string }) {
	if (error === "") return null;
	return (
		<p className="note mx-error" role="alert">
			{error}
		</p>
	);
}
