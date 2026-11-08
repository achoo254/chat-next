/** Usage page — last 30 days of request and bandwidth stats */

import { UsageChart, type UsageDay } from "../components/usage-chart.js";
import { useApi } from "../hooks/use-api.js";

interface UsageResponse {
	days: UsageDay[];
	totals: {
		requests: number;
		bytesIn: number;
		bytesOut: number;
	};
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024)
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function UsagePage(): React.ReactElement {
	const { data, loading, error } = useApi<UsageResponse>("/api/usage");

	return (
		<div className="max-w-3xl mx-auto px-4 py-8">
			<h1 className="text-xl font-semibold mb-6">Usage — last 30 days</h1>

			{loading && <p className="text-gray-500 text-sm">Loading usage data…</p>}
			{error && <p className="text-red-600 text-sm">Error: {error}</p>}

			{data && (
				<>
					<div className="grid grid-cols-3 gap-4 mb-8">
						<div className="bg-white border rounded-lg p-4 text-center">
							<p className="text-2xl font-bold text-blue-600">
								{data.totals.requests.toLocaleString()}
							</p>
							<p className="text-sm text-gray-500 mt-1">Requests</p>
						</div>
						<div className="bg-white border rounded-lg p-4 text-center">
							<p className="text-2xl font-bold text-emerald-600">
								{formatBytes(data.totals.bytesIn)}
							</p>
							<p className="text-sm text-gray-500 mt-1">Inbound</p>
						</div>
						<div className="bg-white border rounded-lg p-4 text-center">
							<p className="text-2xl font-bold text-amber-600">
								{formatBytes(data.totals.bytesOut)}
							</p>
							<p className="text-sm text-gray-500 mt-1">Outbound</p>
						</div>
					</div>

					<div className="bg-white border rounded-lg p-6">
						<UsageChart data={data.days} />
					</div>
				</>
			)}
		</div>
	);
}
