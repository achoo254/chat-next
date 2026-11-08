/** Bar chart showing daily request counts for the last 30 days */

import {
	Bar,
	BarChart,
	CartesianGrid,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";

export interface UsageDay {
	date: string;
	requests: number;
	bytesIn: number;
	bytesOut: number;
}

interface UsageChartProps {
	data: UsageDay[];
}

function formatDate(dateStr: string): string {
	const d = new Date(dateStr);
	return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function UsageChart({ data }: UsageChartProps): React.ReactElement {
	const chartData = data.map((d) => ({
		...d,
		label: formatDate(d.date),
	}));

	return (
		<div className="flex flex-col gap-6">
			<div>
				<h3 className="text-sm font-medium text-gray-700 mb-3">
					Requests per day
				</h3>
				<ResponsiveContainer width="100%" height={220}>
					<BarChart
						data={chartData}
						margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
					>
						<CartesianGrid
							strokeDasharray="3 3"
							vertical={false}
							stroke="#f0f0f0"
						/>
						<XAxis
							dataKey="label"
							tick={{ fontSize: 11, fill: "#9ca3af" }}
							tickLine={false}
							axisLine={false}
							interval="preserveStartEnd"
						/>
						<YAxis
							tick={{ fontSize: 11, fill: "#9ca3af" }}
							tickLine={false}
							axisLine={false}
							width={36}
						/>
						<Tooltip
							formatter={(value: number) => [
								value.toLocaleString(),
								"Requests",
							]}
							labelFormatter={(label: string) => `Date: ${label}`}
							cursor={{ fill: "#f3f4f6" }}
						/>
						<Bar dataKey="requests" fill="#3b82f6" radius={[3, 3, 0, 0]} />
					</BarChart>
				</ResponsiveContainer>
			</div>

			<div>
				<h3 className="text-sm font-medium text-gray-700 mb-3">
					Bandwidth per day
				</h3>
				<ResponsiveContainer width="100%" height={180}>
					<BarChart
						data={chartData}
						margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
					>
						<CartesianGrid
							strokeDasharray="3 3"
							vertical={false}
							stroke="#f0f0f0"
						/>
						<XAxis
							dataKey="label"
							tick={{ fontSize: 11, fill: "#9ca3af" }}
							tickLine={false}
							axisLine={false}
							interval="preserveStartEnd"
						/>
						<YAxis
							tick={{ fontSize: 11, fill: "#9ca3af" }}
							tickLine={false}
							axisLine={false}
							width={48}
							tickFormatter={formatBytes}
						/>
						<Tooltip
							formatter={(value: number, name: string) => [
								formatBytes(value),
								name === "bytesIn" ? "In" : "Out",
							]}
							cursor={{ fill: "#f3f4f6" }}
						/>
						<Bar
							dataKey="bytesIn"
							fill="#10b981"
							radius={[3, 3, 0, 0]}
							name="bytesIn"
						/>
						<Bar
							dataKey="bytesOut"
							fill="#f59e0b"
							radius={[3, 3, 0, 0]}
							name="bytesOut"
						/>
					</BarChart>
				</ResponsiveContainer>
			</div>
		</div>
	);
}
