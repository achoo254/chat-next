/** Login page — email, password, and TOTP code */

import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../hooks/use-auth.js";

export function LoginPage(): React.ReactElement {
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();
	const { login, loading, error, clearError } = useAuth();

	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [totpCode, setTotpCode] = useState("");

	async function handleSubmit(e: React.FormEvent): Promise<void> {
		e.preventDefault();
		clearError();
		const ok = await login(email.trim(), password, totpCode);
		if (ok) navigate(searchParams.get("next") || "/keys");
	}

	return (
		<div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
			<div className="bg-white rounded-lg shadow p-8 w-full max-w-sm">
				<h1 className="text-2xl font-bold mb-6 text-center">Sign in</h1>
				<form
					onSubmit={(e) => void handleSubmit(e)}
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
							autoComplete="current-password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							className="w-full border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
							disabled={loading}
						/>
					</div>
					<div>
						<label
							htmlFor="totp"
							className="block text-sm font-medium text-gray-700 mb-1"
						>
							Authenticator code
						</label>
						<input
							id="totp"
							type="text"
							inputMode="numeric"
							pattern="\d{6}"
							maxLength={6}
							placeholder="6-digit code"
							autoComplete="one-time-code"
							value={totpCode}
							onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ""))}
							className="w-full border rounded px-3 py-2 font-mono text-center tracking-widest focus:outline-none focus:ring-2 focus:ring-blue-500"
							disabled={loading}
						/>
					</div>
					{error && <p className="text-sm text-red-600">{error}</p>}
					<button
						type="submit"
						disabled={loading}
						className="bg-blue-600 text-white rounded px-4 py-2 font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
					>
						{loading ? "Signing in…" : "Sign in"}
					</button>
				</form>
				<p className="text-sm text-center text-gray-500 mt-4">
					No account?{" "}
					<a href="/signup" className="text-blue-600 hover:underline">
						Create one
					</a>
				</p>
			</div>
		</div>
	);
}
