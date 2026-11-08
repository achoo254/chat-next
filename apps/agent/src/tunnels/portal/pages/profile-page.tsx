/** Profile page — change password */

import { useState } from "react";
import { apiFetch } from "../api/client.js";

export function ProfilePage(): React.ReactElement {
	const [currentPassword, setCurrentPassword] = useState("");
	const [newPassword, setNewPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState(false);

	async function handleSubmit(e: React.FormEvent): Promise<void> {
		e.preventDefault();
		setError(null);
		setSuccess(false);

		if (newPassword.length < 8) {
			setError("New password must be at least 8 characters");
			return;
		}
		if (newPassword !== confirmPassword) {
			setError("New passwords do not match");
			return;
		}
		if (newPassword === currentPassword) {
			setError("New password must differ from current password");
			return;
		}

		setLoading(true);
		const res = await apiFetch("/api/auth/password", {
			method: "PUT",
			body: JSON.stringify({ currentPassword, newPassword }),
		});
		setLoading(false);

		if (!res.ok) {
			setError(res.error);
		} else {
			setSuccess(true);
			setCurrentPassword("");
			setNewPassword("");
			setConfirmPassword("");
		}
	}

	return (
		<div className="max-w-md mx-auto px-4 py-8">
			<h1 className="text-xl font-semibold mb-6">Profile</h1>

			<div className="bg-white border rounded-lg p-6">
				<h2 className="text-base font-medium mb-4">Change password</h2>
				<form
					onSubmit={(e) => void handleSubmit(e)}
					className="flex flex-col gap-4"
				>
					<div>
						<label
							htmlFor="current-password"
							className="block text-sm font-medium text-gray-700 mb-1"
						>
							Current password
						</label>
						<input
							id="current-password"
							type="password"
							required
							autoComplete="current-password"
							value={currentPassword}
							onChange={(e) => setCurrentPassword(e.target.value)}
							className="w-full border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
							disabled={loading}
						/>
					</div>
					<div>
						<label
							htmlFor="new-password"
							className="block text-sm font-medium text-gray-700 mb-1"
						>
							New password
						</label>
						<input
							id="new-password"
							type="password"
							required
							autoComplete="new-password"
							value={newPassword}
							onChange={(e) => setNewPassword(e.target.value)}
							className="w-full border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
							disabled={loading}
						/>
					</div>
					<div>
						<label
							htmlFor="confirm-password"
							className="block text-sm font-medium text-gray-700 mb-1"
						>
							Confirm new password
						</label>
						<input
							id="confirm-password"
							type="password"
							required
							autoComplete="new-password"
							value={confirmPassword}
							onChange={(e) => setConfirmPassword(e.target.value)}
							className="w-full border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
							disabled={loading}
						/>
					</div>

					{error && <p className="text-sm text-red-600">{error}</p>}
					{success && (
						<p className="text-sm text-green-600 font-medium">
							Password changed successfully.
						</p>
					)}

					<button
						type="submit"
						disabled={loading}
						className="bg-blue-600 text-white rounded px-4 py-2 font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
					>
						{loading ? "Saving…" : "Change password"}
					</button>
				</form>
			</div>
		</div>
	);
}
