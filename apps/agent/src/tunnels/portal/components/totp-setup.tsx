/** TOTP setup component — displays QR code and verifies 6-digit code */

import { useState } from "react";

interface TotpSetupProps {
	qrCodeUrl: string;
	totpSecret: string;
	userId: string;
	onVerified: () => void;
	onVerify: (userId: string, code: string) => Promise<boolean>;
	loading: boolean;
	error: string | null;
}

export function TotpSetup({
	qrCodeUrl,
	totpSecret,
	userId,
	onVerified,
	onVerify,
	loading,
	error,
}: TotpSetupProps): React.ReactElement {
	const [code, setCode] = useState("");
	const [localError, setLocalError] = useState<string | null>(null);

	async function handleSubmit(e: React.FormEvent): Promise<void> {
		e.preventDefault();
		setLocalError(null);

		if (!/^\d{6}$/.test(code)) {
			setLocalError("Code must be exactly 6 digits");
			return;
		}

		const ok = await onVerify(userId, code);
		if (ok) {
			onVerified();
		}
	}

	const displayError = localError ?? error;

	return (
		<div className="flex flex-col items-center gap-6">
			<div>
				<h2 className="text-lg font-semibold text-center mb-1">
					Set up two-factor authentication
				</h2>
				<p className="text-sm text-gray-500 text-center">
					Scan the QR code with your authenticator app, then enter the 6-digit
					code.
				</p>
			</div>

			<img
				src={qrCodeUrl}
				alt="TOTP QR Code"
				className="w-48 h-48 border rounded"
			/>

			<div className="text-center">
				<p className="text-xs text-gray-500 mb-1">Manual entry key:</p>
				<code className="text-xs bg-gray-100 px-2 py-1 rounded font-mono break-all">
					{totpSecret}
				</code>
			</div>

			<form
				onSubmit={(e) => void handleSubmit(e)}
				className="w-full max-w-xs flex flex-col gap-3"
			>
				<input
					type="text"
					inputMode="numeric"
					pattern="\d{6}"
					maxLength={6}
					placeholder="6-digit code"
					value={code}
					onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
					className="border rounded px-3 py-2 text-center text-lg tracking-widest font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
					autoComplete="one-time-code"
					disabled={loading}
				/>
				{displayError && (
					<p className="text-sm text-red-600 text-center">{displayError}</p>
				)}
				<button
					type="submit"
					disabled={loading || code.length !== 6}
					className="bg-blue-600 text-white rounded px-4 py-2 font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
				>
					{loading ? "Verifying…" : "Verify & Activate"}
				</button>
			</form>
		</div>
	);
}
