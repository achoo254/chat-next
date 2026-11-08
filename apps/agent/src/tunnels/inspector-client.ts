import type { InspectorEntry, InspectorEntrySummary } from "./request-store.js";

/** Reads the request inspector of a running `tunelo http` on this machine. */
function inspectorUrl(port: number, path: string): string {
	return `http://127.0.0.1:${port}/api/requests${path}`;
}

/** Recent requests, newest first, without headers or bodies. */
export async function fetchInspectorRequests(
	port: number,
): Promise<InspectorEntrySummary[]> {
	const res = await fetch(inspectorUrl(port, ""));
	if (!res.ok) throw new Error(`inspector answered ${res.status}`);
	return (await res.json()) as InspectorEntrySummary[];
}

/** One request with headers and bodies; null once it left the inspector. */
export async function fetchInspectorRequest(
	port: number,
	id: string,
): Promise<InspectorEntry | null> {
	const res = await fetch(inspectorUrl(port, `/${encodeURIComponent(id)}`));
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`inspector answered ${res.status}`);
	return (await res.json()) as InspectorEntry;
}
