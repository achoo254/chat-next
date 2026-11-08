/** Modal for creating a new API key — shows plaintext key once after creation */

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../api/client.js";

interface KeyCreateModalProps {
	onClose: () => void;
	onCreated: () => void;
}

interface CreateKeyResponse {
	id: string;
	name: string;
	plaintext: string;
	prefix: string;
	createdAt: string;
}

export function KeyCreateModal({
	onClose,
	onCreated,
}: KeyCreateModalProps): React.ReactElement {
	const [name, setName] = useState("");
	const [plaintext, setPlaintext] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const nameInputRef = useRef<HTMLInputElement>(null);

	// Focus the name field when the create form opens (dialog-open UX).
	useEffect(() => {
		nameInputRef.current?.focus();
	}, []);

	async function handleCreate(e: React.FormEvent): Promise<void> {
		e.preventDefault();
		const trimmed = name.trim();
		if (!trimmed) {
			setError("Name is required");
			return;
		}
		setLoading(true);
		setError(null);
		const res = await apiFetch<CreateKeyResponse>("/api/keys", {
			method: "POST",
			body: JSON.stringify({ name: trimmed }),
		});
		setLoading(false);
		if (!res.ok) {
			setError(res.error);
			return;
		}
		setPlaintext(res.data.plaintext);
		onCreated();
	}

	async function handleCopy(): Promise<void> {
		if (!plaintext) return;
		await navigator.clipboard.writeText(plaintext);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	}

	return (
		<div
			className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
			onKeyDown={(e) => {
				if (e.key === "Escape") onClose();
			}}
		>
			<div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
				<h2 className="text-lg font-semibold mb-4">Create API Key</h2>

				{plaintext ? (
					<div className="flex flex-col gap-4">
						<p className="text-sm text-gray-600">
							Copy your key now — it will not be shown again.
						</p>
						<div className="flex items-center gap-2 bg-gray-50 border rounded px-3 py-2">
							<input
								ref={inputRef}
								readOnly
								value={plaintext}
								className="flex-1 font-mono text-xs bg-transparent focus:outline-none"
								onFocus={(e) => e.target.select()}
							/>
							<button
								type="button"
								onClick={() => void handleCopy()}
								className="text-xs font-medium text-blue-600 hover:text-blue-800 whitespace-nowrap"
							>
								{copied ? "Copied!" : "Copy"}
							</button>
						</div>
						<button
							type="button"
							onClick={onClose}
							className="bg-gray-900 text-white rounded px-4 py-2 font-medium hover:bg-gray-700 transition-colors"
						>
							Done
						</button>
					</div>
				) : (
					<form
						onSubmit={(e) => void handleCreate(e)}
						className="flex flex-col gap-4"
					>
						<div>
							<label
								htmlFor="key-name"
								className="block text-sm font-medium text-gray-700 mb-1"
							>
								Key name
							</label>
							<input
								ref={nameInputRef}
								id="key-name"
								type="text"
								placeholder="e.g. My laptop"
								value={name}
								onChange={(e) => setName(e.target.value)}
								className="w-full border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
								disabled={loading}
							/>
						</div>
						{error && <p className="text-sm text-red-600">{error}</p>}
						<div className="flex gap-3 justify-end">
							<button
								type="button"
								onClick={onClose}
								className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900"
							>
								Cancel
							</button>
							<button
								type="submit"
								disabled={loading}
								className="bg-blue-600 text-white rounded px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
							>
								{loading ? "Creating…" : "Create"}
							</button>
						</div>
					</form>
				)}
			</div>
		</div>
	);
}
