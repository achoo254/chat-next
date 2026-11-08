/** Device auth confirmation page — user approves CLI device code */

import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiFetch } from "../api/client.js";
import { useAuth } from "../hooks/use-auth.js";

type PageState = "confirm" | "loading" | "success" | "error";

export function DeviceAuthPage(): React.ReactElement {
	const [searchParams] = useSearchParams();
	const { user, loading: authLoading } = useAuth();
	const userCode = searchParams.get("code");

	const [state, setState] = useState<PageState>("confirm");
	const [errorMsg, setErrorMsg] = useState("");

	if (!userCode) {
		return (
			<div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
				<div className="bg-white rounded-lg shadow p-8 w-full max-w-sm text-center">
					<p className="text-red-600">No device code provided.</p>
					<p className="text-sm text-gray-500 mt-2">
						This page should be opened from your CLI terminal.
					</p>
				</div>
			</div>
		);
	}

	async function handleApprove(): Promise<void> {
		setState("loading");
		const res = await apiFetch<{ success: boolean }>(
			"/api/auth/device/approve",
			{
				method: "POST",
				body: JSON.stringify({ userCode }),
			},
		);

		if (res.ok) {
			setState("success");
		} else {
			setErrorMsg(res.error);
			setState("error");
		}
	}

	if (authLoading) {
		return (
			<div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
				<div className="bg-white rounded-lg shadow p-8 w-full max-w-sm text-center">
					<p className="text-gray-500">Loading...</p>
				</div>
			</div>
		);
	}

	return (
		<div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
			<div className="bg-white rounded-lg shadow p-8 w-full max-w-sm">
				{state === "success" ? (
					<div className="text-center">
						<div className="text-4xl mb-4">&#10003;</div>
						<h1 className="text-xl font-bold text-green-700 mb-2">
							Device authorized!
						</h1>
						<p className="text-gray-500">
							You can close this tab and return to your terminal.
						</p>
					</div>
				) : (
					<>
						<h1 className="text-2xl font-bold mb-4 text-center">
							Authorize Device
						</h1>

						{user && (
							<p className="text-sm text-gray-500 text-center mb-4">
								Signed in as <strong>{user.email}</strong>
							</p>
						)}

						<p className="text-sm text-gray-600 mb-4 text-center">
							Make sure this code matches what you see in your terminal:
						</p>

						<div className="bg-gray-100 rounded-lg p-4 mb-6 text-center">
							<span className="font-mono text-2xl tracking-widest font-bold">
								{userCode}
							</span>
						</div>

						{state === "error" && (
							<p className="text-sm text-red-600 mb-4 text-center">
								{errorMsg}
							</p>
						)}

						<button
							type="button"
							onClick={() => void handleApprove()}
							disabled={state === "loading"}
							className="w-full bg-green-600 text-white rounded px-4 py-2 font-medium hover:bg-green-700 disabled:opacity-50 transition-colors"
						>
							{state === "loading" ? "Approving..." : "Approve"}
						</button>

						{state === "error" && (
							<button
								type="button"
								onClick={() => setState("confirm")}
								className="w-full mt-2 text-gray-600 text-sm hover:underline"
							>
								Try again
							</button>
						)}
					</>
				)}
			</div>
		</div>
	);
}
