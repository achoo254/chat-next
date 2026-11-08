/** API keys management page — list, create, revoke */

import { useState } from "react";
import { apiFetch } from "../api/client.js";
import { KeyCreateModal } from "../components/key-create-modal.js";
import { KeyList } from "../components/key-list.js";
import { useApi } from "../hooks/use-api.js";

export interface ApiKey {
	id: string;
	name: string;
	prefix: string;
	createdAt: string;
}

export function KeysPage(): React.ReactElement {
	const { data: keys, loading, error, refetch } = useApi<ApiKey[]>("/api/keys");
	const [showModal, setShowModal] = useState(false);
	const [revoking, setRevoking] = useState<string | null>(null);
	const [revokeError, setRevokeError] = useState<string | null>(null);

	async function handleRevoke(id: string): Promise<void> {
		const confirmed = window.confirm(
			"Revoke this API key? This cannot be undone.",
		);
		if (!confirmed) return;

		setRevoking(id);
		setRevokeError(null);
		const res = await apiFetch(`/api/keys/${id}`, { method: "DELETE" });
		setRevoking(null);

		if (!res.ok) {
			setRevokeError(res.error);
		} else {
			refetch();
		}
	}

	function handleCreated(): void {
		refetch();
	}

	return (
		<div className="max-w-3xl mx-auto px-4 py-8">
			<div className="flex items-center justify-between mb-6">
				<h1 className="text-xl font-semibold">API Keys</h1>
				<button
					type="button"
					onClick={() => setShowModal(true)}
					className="bg-blue-600 text-white text-sm rounded px-4 py-2 font-medium hover:bg-blue-700 transition-colors"
				>
					New key
				</button>
			</div>

			{loading && <p className="text-gray-500 text-sm">Loading keys…</p>}
			{error && <p className="text-red-600 text-sm">Error: {error}</p>}
			{revokeError && (
				<p className="text-red-600 text-sm mb-4">
					Revoke failed: {revokeError}
				</p>
			)}
			{!loading && !error && (
				<KeyList
					keys={keys ?? []}
					onRevoke={(id) => void handleRevoke(id)}
					revoking={revoking}
				/>
			)}

			{showModal && (
				<KeyCreateModal
					onClose={() => setShowModal(false)}
					onCreated={handleCreated}
				/>
			)}
		</div>
	);
}
