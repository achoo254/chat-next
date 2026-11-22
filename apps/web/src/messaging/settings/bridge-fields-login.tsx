// Signing in to an app by typed fields (Telegram, Chat Bridge ADR 0022): each
// step shows the fields the app asks for (phone, code, two-step password) until
// the account is connected. Drawn in the shared sign-in frame, like the QR login
// (bridge-qr-login.tsx). The values go to the server in the call that needs them
// and are never kept here.
import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from "react";
import type { BridgeApi, BridgeError, LoginStep } from "./bridge-api.ts";
import { BridgeSignInFrame, type SignInStatus } from "./bridge-sign-in-frame.tsx";
import { useBridgeCopy } from "./use-bridge-copy.ts";

export interface BridgeLoginProps {
	api: BridgeApi;
	source: string;
	appName: string;
	onDone: () => void;
	onCancel: () => void;
	onError: (err: unknown) => BridgeError;
}

/** What a failed login step says to the user. */
function loginErrorText(error: BridgeError, t: ReturnType<typeof useBridgeCopy>): string {
	switch (error.kind) {
		case "wrong_input":
			return t.login.errors[error.detail] ?? t.failed;
		case "rate_limited":
			return t.login.rateLimited;
		case "account_taken":
			return t.login.accountTaken;
		default:
			return t.failed;
	}
}

export function BridgeFieldsLogin({ api, source, appName, onDone, onCancel, onError }: BridgeLoginProps) {
	const t = useBridgeCopy();
	const [step, setStep] = useState<LoginStep | null>(null);
	const [values, setValues] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const firstField = useRef<HTMLInputElement>(null);

	const advance = (next: LoginStep) => {
		if (next.kind === "done") return onDone();
		setStep(next);
		setValues({});
		setError("");
	};
	const begin = useEffectEvent(() => {
		api.startLogin(source).then(advance, (err: unknown) => setError(loginErrorText(onError(err), t)));
	});
	useEffect(() => {
		begin();
	}, []);
	// Each new step puts the cursor in its first field, so the user can type straight away.
	useEffect(() => {
		firstField.current?.focus();
	}, [step]);

	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (step === null || step.kind === "done") return;
		setBusy(true);
		setError("");
		api.continueLogin(step.loginId, values).then(
			(next) => {
				setBusy(false);
				advance(next);
			},
			(err: unknown) => {
				setBusy(false);
				setError(loginErrorText(onError(err), t));
			},
		);
	};
	const fields = step?.kind === "input" ? step.fields : [];
	const ready = fields.length > 0 && fields.every((f) => (values[f.name] ?? "").trim() !== "");
	const status: SignInStatus | undefined =
		error !== "" ? { text: error, tone: "error" } : step === null ? { text: t.login.preparing, tone: "info", state: "preparing" } : undefined;
	return (
		<BridgeSignInFrame
			dataId="bridge-login"
			appName={appName}
			method={t.login.method}
			title={t.login.title(appName)}
			status={status}
			onSubmit={submit}
			actions={
				<>
					<button type="submit" className="btn btn-primary" disabled={busy || !ready}>
						{t.login.next}
					</button>
					<button type="button" className="btn" onClick={onCancel}>
						{t.login.cancel}
					</button>
				</>
			}
		>
			{/* A QR step's prompt is an image (see bridge-qr-login.tsx), never shown as text. */}
			{(step?.kind === "input" || step?.kind === "confirm") && step.prompt !== "" && <p className="note">{step.prompt}</p>}
			{step?.kind === "qr" && <p className="note">{t.login.scan}</p>}
			{step?.kind === "confirm" && <p className="note">{t.login.confirm}</p>}
			{fields.map((field, index) => (
				<label className="field" key={field.name}>
					<span>{t.login.fields[field.name] ?? field.label}</span>
					<input
						ref={index === 0 ? firstField : undefined}
						className="input"
						name={field.name}
						type={field.name === "phone" ? "tel" : field.secret ? "password" : "text"}
						inputMode={field.name === "code" ? "numeric" : undefined}
						autoComplete="off"
						value={values[field.name] ?? ""}
						onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}
					/>
				</label>
			))}
		</BridgeSignInFrame>
	);
}
