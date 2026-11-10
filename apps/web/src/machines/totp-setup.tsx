// "Ghép bằng Authenticator" on a machine's settings, for a device already
// paired with it: turn the pairing code on, or replace it. This browser makes
// the secret, shows it once (QR code and text), and checks the first code the
// user types against it; only a matching code sends the secret, inside the
// end-to-end encrypted session, to the machine, which keeps it. The secret
// lives in this dialog's state only: never stored, logged or sent anywhere
// else, and gone with the dialog, so it cannot be shown again.
import { useState, type ReactElement } from "react";
import { ErrorReason } from "@achoo254/chat-proto/remote/remote";
import { base32Encode, generateTotpSecret, totpUri, verifyTotp } from "@achoo254/chat-remote-protocol";
import { brand } from "../brand.ts";
import { Icon } from "../components/screen-icons.tsx";
import { CopyButton, DialogHead, Modal, useDomId } from "../messaging/ui/parts.tsx";
import { CodeInput } from "./code-input.tsx";
import type { MachinesCopy } from "./copy-vi.ts";
import { OfflineError, RemoteError, type MachineLink } from "./link/machine-link.ts";
import { QrCode } from "./qr-code.tsx";
import { useMachinesCopy } from "./use-machines-copy.ts";

interface TotpSettingProps {
	link: MachineLink;
	/** The machine's name: the entry's label in the Authenticator app. */
	machine: string;
	/** MachineInfo.totpEnabled as the machine last reported it. */
	enabled: boolean;
	online: boolean;
}

export function TotpSetting({ link, machine, enabled, online }: TotpSettingProps): ReactElement {
	const t = useMachinesCopy();
	const [open, setOpen] = useState(false);
	const [done, setDone] = useState(false);
	const finish = () => {
		setOpen(false);
		setDone(true);
		// The machine's info carries the new state for every page.
		link.request({ case: "machineInfoRequest", value: {} }).catch(() => undefined);
	};
	return (
		<div className="mx-totp" data-id="machine-totp">
			<span className="note">{done ? t.totp.done : enabled ? t.totp.on : t.totp.off}</span>
			<div>
				<button type="button" className="btn btn-sm" disabled={!online} data-id="machine-totp-start" onClick={() => setOpen(true)}>
					{enabled || done ? t.totp.regenerate : t.totp.enable}
				</button>
			</div>
			{open && <TotpDialog link={link} machine={machine} replacing={enabled || done} onDone={finish} onClose={() => setOpen(false)} />}
		</div>
	);
}

function TotpDialog({ link, machine, replacing, onDone, onClose }: { link: MachineLink; machine: string; replacing: boolean; onDone: () => void; onClose: () => void }): ReactElement {
	const t = useMachinesCopy();
	const id = useDomId("totp");
	const [secret] = useState(generateTotpSecret);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	/** Bumped after each refused code: the boxes clear for the next one. */
	const [attempt, setAttempt] = useState(0);
	const key = base32Encode(secret);
	const uri = totpUri({ secret, label: machine, issuer: brand.appName });

	const confirm = (code: string) => {
		setError("");
		// Checked here first: a secret the user's app does not hold never reaches the machine.
		if (!verifyTotp(secret, code)) {
			setError(t.totp.wrong);
			setAttempt((n) => n + 1);
			return;
		}
		setSaving(true);
		link.request({ case: "totpSet", value: { secret } }).then(
			(frame) => {
				if (frame.body.case === "totpStatus" && frame.body.value.enabled) {
					onDone();
					return;
				}
				setSaving(false);
				setError(t.totp.failed);
				setAttempt((n) => n + 1);
			},
			(err: unknown) => {
				setSaving(false);
				setError(setupError(t, err));
				setAttempt((n) => n + 1);
			},
		);
	};

	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={replacing ? t.totp.regenerate : t.totp.enable} onClose={onClose} />
			<div className="dlg-body stack" data-id="totp-setup">
				{replacing && (
					<div className="mx-hint warn" role="note" data-id="totp-setup-replace">
						<Icon name="alert" small />
						<span>{t.totp.regenerateWarn}</span>
					</div>
				)}
				<ol className="mx-steps">
					<li>
						<p>{t.totp.scan}</p>
						<div data-id="totp-setup-qr">
							<QrCode text={uri} label={t.totp.qr(machine)} />
						</div>
						<p className="note">{t.totp.manual}</p>
						<div className="mx-cmd" data-id="totp-setup-secret">
							<code aria-label={t.totp.secret}>{groups(key)}</code>
							<CopyButton text={key} label={t.totp.copy} copiedLabel={t.totp.copied} small />
						</div>
					</li>
					<li>
						<p>{t.totp.enter}</p>
						<div className="mx-otp-wrap" data-id="totp-setup-code">
							<CodeInput key={attempt} label={t.totp.code} disabled={saving} onCode={confirm} />
						</div>
					</li>
				</ol>
				{saving && (
					<div className="mx-wait" role="status">
						<span className="spin" aria-hidden="true" />
						{t.totp.saving}
					</div>
				)}
				{error !== "" && (
					<p className="mx-error" role="alert">
						{error}
					</p>
				)}
				<p className="note">{t.totp.once}</p>
			</div>
			<div className="dlg-foot">
				<button type="button" className="btn" onClick={onClose}>
					{t.totp.cancel}
				</button>
			</div>
		</Modal>
	);
}

function setupError(t: MachinesCopy, err: unknown): string {
	if (err instanceof OfflineError) return t.totp.offline;
	if (err instanceof RemoteError && err.reason === ErrorReason.TOTP_SECRET_INVALID) return t.errors.reasons.totpSecretInvalid;
	return t.totp.failed;
}

/** "ABCD EFGH …": easier to copy by hand into an Authenticator app. */
function groups(key: string): string {
	return key.replace(/(.{4})(?=.)/g, "$1 ");
}
