// Signing in to an app by QR code (Zalo, Chat Bridge ADR 0022): a notice the
// user accepts first, then the code with short numbered steps and a live
// status line, until the phone confirms. Used for a new connection and for an
// account that needs signing in again. Drawn in the shared sign-in frame, like
// the login by fields (bridge-fields-login.tsx). The image is rendered only
// when it is a checked PNG data: URL and is dropped when the login ends.
import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components/screen-icons.tsx";
import { useServices } from "../data/services.tsx";
import type { BridgeLoginProps } from "./bridge-fields-login.tsx";
import { BridgeQrNotice } from "./bridge-qr-notice.tsx";
import { BridgeSignInFrame, type SignInTone } from "./bridge-sign-in-frame.tsx";
import { isEnded, isSafeQrDataUrl, type QrLoginStatus } from "./qr-login-model.ts";
import { useBridgeCopy } from "./use-bridge-copy.ts";
import { useQrLogin } from "./use-qr-login.ts";

/** Side of the QR image in CSS pixels (scannable from a phone held at arm's length). */
const QR_SIZE = 264;

/** Statuses read as a problem; "confirm" is good news; the rest are plain hints. */
const PROBLEMS: ReadonlySet<QrLoginStatus> = new Set(["network", "declined", "expired", "limited", "taken", "failed"]);

function toneOf(status: QrLoginStatus): SignInTone {
	if (status === "confirm") return "success";
	return PROBLEMS.has(status) ? "error" : "info";
}

export function BridgeQrLogin({ api, source, appName, onDone, onCancel, onError }: BridgeLoginProps) {
	const t = useBridgeCopy();
	const { toasts } = useServices();
	const [accepted, setAccepted] = useState(false);
	const login = useQrLogin(
		api,
		source,
		() => {
			toasts.show(t.qr.status.done(appName));
			onDone();
		},
		onError,
	);
	const heading = useRef<HTMLHeadingElement>(null);
	const action = useRef<HTMLButtonElement>(null);
	const cancelButton = useRef<HTMLButtonElement>(null);
	const { status, wait: seconds } = login;
	const ended = status !== "idle" && isEnded(status);

	// Keyboard users land on the new step: the code's heading when it opens, the way on when it fails.
	useEffect(() => {
		if (accepted) heading.current?.focus();
	}, [accepted]);
	useEffect(() => {
		if (status !== "network" && !ended) return;
		const next = action.current !== null && !action.current.disabled ? action.current : cancelButton.current;
		next?.focus();
	}, [status, ended]);

	if (!accepted) {
		return (
			<BridgeQrNotice
				appName={appName}
				onAccept={() => {
					setAccepted(true);
					login.start();
				}}
				onCancel={onCancel}
			/>
		);
	}
	const image = isSafeQrDataUrl(login.image) ? login.image : "";
	const cancel = () => {
		login.stop();
		onCancel();
	};
	return (
		<BridgeSignInFrame
			dataId="bridge-qr-login"
			appName={appName}
			method={t.qr.method}
			title={t.qr.title(appName)}
			headingRef={heading}
			status={
				status === "idle"
					? undefined
					: {
							text: (
								<>
									{t.qr.status[status]}
									{status === "limited" && seconds > 0 && <span className="br-qr-wait"> {t.qr.status.limitedIn(seconds)}</span>}
								</>
							),
							tone: toneOf(status),
							state: status,
						}
			}
			actions={
				<>
					{status === "network" && (
						<button type="button" className="btn btn-primary" data-id="bridge-qr-login-retry" ref={action} onClick={login.resume}>
							{t.qr.retry}
						</button>
					)}
					{ended && (
						<button
							type="button"
							className="btn btn-primary"
							data-id="bridge-qr-login-restart"
							ref={action}
							disabled={status === "limited" && seconds > 0}
							onClick={login.start}
						>
							{t.qr.startAgain}
						</button>
					)}
					<button type="button" className="btn" data-id="bridge-qr-login-cancel" ref={cancelButton} onClick={cancel}>
						{t.qr.cancel}
					</button>
				</>
			}
		>
			<div className="br-qr-body">
				<div className="br-qr-frame" data-id="bridge-qr-login-code" data-ready={image !== ""}>
					{image !== "" ? (
						<img className="br-qr-image" src={image} alt={t.qr.imageAlt(appName)} width={QR_SIZE} height={QR_SIZE} draggable={false} />
					) : (
						<span className="br-qr-placeholder" aria-hidden="true">
							<Icon name={status === "confirm" ? "mobile" : "refresh"} />
						</span>
					)}
				</div>
				<ol className="br-qr-steps">
					{t.qr.steps(appName).map((step) => (
						<li key={step}>{step}</li>
					))}
				</ol>
			</div>
		</BridgeSignInFrame>
	);
}
