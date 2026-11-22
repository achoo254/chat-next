// The notice shown before a QR login of an app with no official API for
// personal accounts (Zalo): what the unofficial connection risks and what Chat
// does with the account. Drawn in the shared sign-in frame, so it reads as the
// first step of the same card. Nothing reaches the server until the user ticks
// the box and continues.
import { useState } from "react";
import { BridgeSignInFrame } from "./bridge-sign-in-frame.tsx";
import { useBridgeCopy } from "./use-bridge-copy.ts";

export function BridgeQrNotice({ appName, onAccept, onCancel }: { appName: string; onAccept: () => void; onCancel: () => void }) {
	const t = useBridgeCopy();
	const [accepted, setAccepted] = useState(false);
	return (
		<BridgeSignInFrame
			dataId="bridge-qr-notice"
			appName={appName}
			method={t.qr.method}
			title={t.qr.notice.title(appName)}
			warning
			actions={
				<>
					<button type="button" className="btn btn-primary" data-id="bridge-qr-notice-continue" disabled={!accepted} onClick={onAccept}>
						{t.qr.notice.continue}
					</button>
					<button type="button" className="btn" data-id="bridge-qr-notice-cancel" onClick={onCancel}>
						{t.qr.cancel}
					</button>
				</>
			}
		>
			<ul className="br-qr-points">
				{t.qr.notice.points(appName).map((point) => (
					<li key={point}>{point}</li>
				))}
			</ul>
			<label className="opt check" data-id="bridge-qr-notice-accept">
				<input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />
				<span>{t.qr.notice.accept}</span>
			</label>
		</BridgeSignInFrame>
	);
}
