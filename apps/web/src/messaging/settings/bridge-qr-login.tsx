// Signing in to an app by QR code (Zalo, Chat Bridge ADR 0022): a notice the
// user accepts first, then the code with short numbered steps and a live
// status line, until the phone confirms. Used for a new connection and for an
// account that needs signing in again. The image is rendered only when it is
// a checked PNG data: URL and is dropped when the login ends.
import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "../../components/screen-icons.tsx";
import { useServices } from "../data/services.tsx";
import type { BridgeApi, BridgeError } from "./bridge-api.ts";
import { BridgeQrNotice } from "./bridge-qr-notice.tsx";
import { isEnded, isSafeQrDataUrl, type QrLoginStatus } from "./qr-login-model.ts";
import { useBridgeCopy } from "./use-bridge-copy.ts";
import { useQrLogin } from "./use-qr-login.ts";

/** Side of the QR image in CSS pixels (scannable from a phone held at arm's length). */
const QR_SIZE = 264;

export function BridgeQrLogin({
	api,
	source,
	appName,
	onDone,
	onCancel,
	onError,
}: {
	api: BridgeApi;
	source: string;
	appName: string;
	onDone: () => void;
	onCancel: () => void;
	onError: (err: unknown) => BridgeError;
}) {
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
	const titleId = useId();
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
		<section className="card pad br-qr" data-id="bridge-qr-login" aria-labelledby={titleId}>
			<h2 className="br-qr-heading" id={titleId} ref={heading} tabIndex={-1}>
				{t.qr.title(appName)}
			</h2>
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
			<p className="br-qr-status" role="status" aria-live="polite" data-id="bridge-qr-login-status" data-state={status}>
				{statusText(status, t)}
				{status === "limited" && seconds > 0 && <span className="br-qr-wait"> {t.qr.status.limitedIn(seconds)}</span>}
			</p>
			<div className="row">
				{status === "network" && (
					<button type="button" className="btn btn-primary" data-id="bridge-qr-login-retry" ref={action} onClick={login.resume}>
						{t.qr.retry}
					</button>
				)}
				{ended && status !== "reauth" && (
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
			</div>
		</section>
	);
}

function statusText(status: QrLoginStatus | "idle", t: ReturnType<typeof useBridgeCopy>): string {
	return status === "idle" ? "" : t.qr.status[status];
}
