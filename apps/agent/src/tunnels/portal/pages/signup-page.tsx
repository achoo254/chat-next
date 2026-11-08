/** Signup flow — Step 1: email+password, Step 2: TOTP setup, Step 3: redirect */

import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { TotpSetup } from "../components/totp-setup.js";
import { type SignupResult, useAuth } from "../hooks/use-auth.js";

type Step = "credentials" | "totp";

export function SignupPage(): React.ReactElement {
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();
	const { signup, verifyTotp, loading, error, clearError } = useAuth();

	const [step, setStep] = useState<Step>("credentials");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [localError, setLocalError] = useState<string | null>(null);
	const [signupResult, setSignupResult] = useState<SignupResult | null>(null);

	async function handleCredentials(e: React.FormEvent): Promise<void> {
		e.preventDefault();
		setLocalError(null);
		clearError();

		if (password.length < 8) {
			setLocalError("Password must be at least 8 characters");
			return;
		}
		if (password !== confirm) {
			setLocalError("Passwords do not match");
			return;
		}

		const result = await signup(email.trim(), password);
		if (result) {
			setSignupResult(result);
			setStep("totp");
		}
	}

	function handleVerified(): void {
		navigate(searchParams.get("next") || "/keys");
	}

	const displayError = localError ?? error;

	if (step === "totp" && signupResult) {
		return (
			<div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
				<div className="bg-white rounded-lg shadow p-8 w-full max-w-sm">
					<TotpSetup
						qrCodeUrl={signupResult.qrCodeUrl}
						totpSecret={signupResult.totpSecret}
						userId={signupResult.userId}
						onVerified={handleVerified}
						onVerify={verifyTotp}
						loading={loading}
						error={error}
					/>
				</div>
			</div>
		);
	}

	return (
		<div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
			<div className="bg-white rounded-lg shadow p-8 w-full max-w-sm">
				<h1 className="text-2xl font-bold mb-6 text-center">Create account</h1>
				<form
					onSubmit={(e) => void handleCredentials(e)}
					className="flex flex-col gap-4"
				>
					<div>
						<label
							htmlFor="email"
							className="block text-sm font-medium text-gray-700 mb-1"
						>
							Email
						</label>
						<input
							id="email"
							type="email"
							required
							autoComplete="email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							className="w-full border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
							disabled={loading}
						/>
					</div>
					<div>
						<label
							htmlFor="password"
							className="block text-sm font-medium text-gray-700 mb-1"
						>
							Password
						</label>
						<input
							id="password"
							type="password"
							required
							autoComplete="new-password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							className="w-full border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
							disabled={loading}
						/>
					</div>
					<div>
						<label
							htmlFor="confirm"
							className="block text-sm font-medium text-gray-700 mb-1"
						>
							Confirm password
						</label>
						<input
							id="confirm"
							type="password"
							required
							autoComplete="new-password"
							value={confirm}
							onChange={(e) => setConfirm(e.target.value)}
							className="w-full border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
							disabled={loading}
						/>
					</div>
					{displayError && (
						<p className="text-sm text-red-600">{displayError}</p>
					)}
					<button
						type="submit"
						disabled={loading}
						className="bg-blue-600 text-white rounded px-4 py-2 font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
					>
						{loading ? "Creating account…" : "Create account"}
					</button>
				</form>
				<p className="text-sm text-center text-gray-500 mt-4">
					Already have an account?{" "}
					<a href="/login" className="text-blue-600 hover:underline">
						Sign in
					</a>
				</p>
			</div>
		</div>
	);
}
