/** Displays a table of API keys with revoke action */

import type { ApiKey } from "../pages/keys-page.js";

interface KeyListProps {
	keys: ApiKey[];
	onRevoke: (id: string) => void;
	revoking: string | null;
}

function maskKey(prefix: string): string {
	return `${prefix}${"•".repeat(24)}`;
}

export function KeyList({
	keys,
	onRevoke,
	revoking,
}: KeyListProps): React.ReactElement {
	if (keys.length === 0) {
		return (
			<p className="text-gray-500 text-sm text-center py-8">
				No API keys yet. Create one to get started.
			</p>
		);
	}

	return (
		<div className="overflow-x-auto">
			<table className="w-full text-sm border-collapse">
				<thead>
					<tr className="border-b text-left text-gray-500">
						<th className="pb-2 pr-4 font-medium">Name</th>
						<th className="pb-2 pr-4 font-medium">Key</th>
						<th className="pb-2 pr-4 font-medium">Created</th>
						<th className="pb-2 font-medium">Actions</th>
					</tr>
				</thead>
				<tbody>
					{keys.map((key) => (
						<tr
							key={key.id}
							className="border-b last:border-0 hover:bg-gray-50"
						>
							<td className="py-3 pr-4 font-medium">{key.name}</td>
							<td className="py-3 pr-4 font-mono text-xs text-gray-600">
								{maskKey(key.prefix)}
							</td>
							<td className="py-3 pr-4 text-gray-500">
								{new Date(key.createdAt).toLocaleDateString()}
							</td>
							<td className="py-3">
								<button
									type="button"
									disabled={revoking === key.id}
									onClick={() => onRevoke(key.id)}
									className="text-red-600 hover:text-red-800 text-xs font-medium disabled:opacity-50 transition-colors"
								>
									{revoking === key.id ? "Revoking…" : "Revoke"}
								</button>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
