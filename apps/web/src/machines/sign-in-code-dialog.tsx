// Adding a Claude account to a machine from this device: the machine starts
// claude's own sign-in and sends its page link here (end to end encrypted);
// the user signs in on that page and pastes back the code it shows, which
// goes to the machine the same way and is not kept anywhere. When the
// machine's claude cannot sign in from a device, the dialog shows the
// command to run on the machine instead.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { DialogHead, Modal, useDomId } from "../messaging/ui/parts.tsx";
import type { MachineLink } from "./link/machine-link.ts";
import type { MachinesCopy } from "./copy-vi.ts";
import { errorText } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

type Step =
	| { kind: "starting" }
	| { kind: "prompt"; attemptId: string; url: string }
	| { kind: "done"; email: string }
	| { kind: "on-machine" }
	| { kind: "failed"; message: string };

interface SignInCodeDialogProps {
	link: MachineLink;
	ai: string;
	/** The AI (ProviderInfo.id) the account signs in to. */
	provider: string;
	/** A profile was added: refresh the list. */
	onAdded: () => void;
	onClose: () => void;
}

/** What a failed sign-in says, by the machine's error code. */
function failedText(t: MachinesCopy, error: string): string {
	return t.profiles.signIn.errors[error] ?? t.errors.generic;
}

/** Only a Claude page opens from here, whatever the machine sent. */
export function safeSignInUrl(url: string): string | null {
	try {
		const u = new URL(url);
		const claude = ["claude.ai", "claude.com"].some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
		return u.protocol === "https:" && claude ? u.toString() : null;
	} catch {
		return null;
	}
}

export function SignInCodeDialog({ link, ai, provider, onAdded, onClose }: SignInCodeDialogProps) {
	const t = useMachinesCopy();
	const s = t.profiles.signIn;
	const id = useDomId("claude-sign-in");
	const [step, setStep] = useState<Step>({ kind: "starting" });
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [round, setRound] = useState(0);
	/** The attempt still open on the machine, cancelled when the dialog closes without finishing. */
	const open = useRef<string | null>(null);

	useEffect(() => {
		let active = true;
		link.request({ case: "accountSignInBegin", value: { provider } }).then(
			(frame) => {
				const b = frame.body;
				if (!active) {
					// Closed before the link came: end that sign-in on the machine too.
					if (b.case === "accountSignInPrompt") link.request({ case: "accountSignInCancel", value: { attemptId: b.value.attemptId, provider } }).catch(() => undefined);
					return;
				}
				if (b.case === "accountSignInPrompt") {
					const url = safeSignInUrl(b.value.url);
					open.current = b.value.attemptId;
					setStep(url === null ? { kind: "failed", message: t.errors.generic } : { kind: "prompt", attemptId: b.value.attemptId, url });
				} else if (b.case === "accountSignInResult") {
					setStep(b.value.error === "sign-in-on-machine" ? { kind: "on-machine" } : { kind: "failed", message: failedText(t, b.value.error) });
				} else {
					setStep({ kind: "failed", message: t.errors.generic });
				}
			},
			(err: unknown) => {
				if (active) setStep({ kind: "failed", message: errorText(t, err, ai) });
			},
		);
		return () => {
			active = false;
		};
		// A new round (Try again) starts a new attempt on the machine.
	}, [link, ai, provider, t, round]);

	const close = () => {
		const attemptId = open.current;
		open.current = null;
		if (attemptId !== null) link.request({ case: "accountSignInCancel", value: { attemptId, provider } }).catch(() => undefined);
		onClose();
	};

	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (step.kind !== "prompt" || code.trim() === "") return;
		setBusy(true);
		setError("");
		link.request({ case: "accountSignInCode", value: { attemptId: step.attemptId, code: code.trim(), provider } }).then(
			(frame) => {
				setBusy(false);
				setCode("");
				const b = frame.body;
				if (b.case !== "accountSignInResult") return setError(t.errors.generic);
				if (b.value.ok) {
					open.current = null;
					setStep({ kind: "done", email: b.value.email });
					onAdded();
					return;
				}
				// The machine ended the attempt; only "busy" leaves it open.
				if (b.value.error !== "busy") open.current = null;
				setStep({ kind: "failed", message: failedText(t, b.value.error) });
			},
			(err: unknown) => {
				setBusy(false);
				setError(errorText(t, err, ai));
			},
		);
	};

	return (
		<Modal labelledBy={id} onClose={close}>
			<DialogHead id={id} title={s.title} onClose={close} />
			{step.kind === "prompt" ? (
				<form onSubmit={submit}>
					<div className="dlg-body stack">
						<p>{s.step1}</p>
						<a className="btn" href={step.url} target="_blank" rel="noopener noreferrer">
							{s.open}
						</a>
						<p>{s.step2}</p>
						<label className="mx-field-row">
							<span>{s.code}</span>
							<input
								className="input mono"
								value={code}
								autoComplete="off"
								autoCapitalize="off"
								spellCheck={false}
								maxLength={1024}
								onChange={(event) => setCode(event.target.value)}
							/>
						</label>
						{error !== "" && (
							<p className="mx-error" role="alert">
								{error}
							</p>
						)}
					</div>
					<div className="dlg-foot">
						<button type="button" className="btn" onClick={close}>
							{s.cancel}
						</button>
						<button type="submit" className="btn btn-primary" disabled={busy || code.trim() === ""}>
							{busy ? s.submitting : s.submit}
						</button>
					</div>
				</form>
			) : (
				<>
					<div className="dlg-body stack">
						{step.kind === "starting" && <p className="muted">{s.starting}</p>}
						{step.kind === "done" && <p role="status">{s.done(step.email)}</p>}
						{step.kind === "failed" && (
							<p className="mx-error" role="alert">
								{step.message}
							</p>
						)}
						{step.kind === "on-machine" && (
							<>
								<h3>{s.onMachineTitle}</h3>
								<p>{s.onMachine}</p>
								<pre className="mono">{s.command}</pre>
							</>
						)}
					</div>
					<div className="dlg-foot">
						{step.kind === "failed" && (
							<button
								type="button"
								className="btn"
								onClick={() => {
									setStep({ kind: "starting" });
									setCode("");
									setError("");
									setRound((n) => n + 1);
								}}
							>
								{s.retry}
							</button>
						)}
						<button type="button" className="btn btn-primary" onClick={close}>
							{s.close}
						</button>
					</div>
				</>
			)}
		</Modal>
	);
}
