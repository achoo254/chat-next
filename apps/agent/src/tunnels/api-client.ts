/**
 * Minimal HTTP client for the Tunelo server API: token verify and
 * `tunelo link`. Account sign-in talks to the identity provider instead
 * (idp-client.ts).
 */

interface ApiErrorResponse {
	error?: { code: string; message: string };
}

export class ApiClientError extends Error {
	constructor(
		public code: string,
		message: string,
		public statusCode: number,
	) {
		super(message);
		this.name = "ApiClientError";
	}
}

/** Derives HTTP API base URL from WS server URL */
export function getApiBaseUrl(serverUrl: string): string {
	return serverUrl
		.replace(/^wss:\/\//, "https://")
		.replace(/^ws:\/\//, "http://")
		.replace(/\/$/, "");
}

async function request<T>(
	baseUrl: string,
	path: string,
	options: { method?: string; apiKey?: string; body?: unknown } = {},
): Promise<T> {
	const headers: Record<string, string> = {};
	if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
	if (options.body !== undefined) headers["Content-Type"] = "application/json";

	const res = await fetch(`${baseUrl}/api${path}`, {
		method: options.method ?? "GET",
		headers,
		body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
		signal: AbortSignal.timeout(15_000),
	});

	const text = await res.text();
	let data: T & ApiErrorResponse;
	try {
		data = JSON.parse(text) as T & ApiErrorResponse;
	} catch {
		throw new ApiClientError(
			"TUNELO_UNKNOWN",
			text || `HTTP ${res.status}`,
			res.status,
		);
	}

	if (!res.ok) {
		throw new ApiClientError(
			data.error?.code ?? "TUNELO_UNKNOWN",
			data.error?.message ?? `HTTP ${res.status}`,
			res.status,
		);
	}

	return data;
}

export interface VerifyResult {
	valid: boolean;
	kind?: "idp" | "legacy" | "link";
	/** ISO date anonymous tokens stop working, when the server set one. */
	legacyTokenCutoff?: string;
	code?: string;
}

/** Checks a token with the server; a rejected token is `{ valid: false }`. */
export async function verifyKey(
	baseUrl: string,
	key: string,
): Promise<VerifyResult> {
	try {
		return await request<VerifyResult>(baseUrl, "/verify", { apiKey: key });
	} catch (err) {
		if (err instanceof ApiClientError && err.statusCode === 401) {
			return { valid: false, code: err.code };
		}
		throw err;
	}
}

/** `tunelo link <code>`: approve a pairing a client (Localman) opened. */
export async function approveLink(
	baseUrl: string,
	key: string,
	code: string,
): Promise<{ clientName: string }> {
	return request(baseUrl, "/links/approve", {
		method: "POST",
		apiKey: key,
		body: { code },
	});
}

export interface LinkInfo {
	id: string;
	clientName: string;
	createdAt: string | null;
	lastUsedAt: string | null;
}

export async function listLinks(
	baseUrl: string,
	key: string,
): Promise<LinkInfo[]> {
	const data = await request<{ links: LinkInfo[] }>(baseUrl, "/links", {
		apiKey: key,
	});
	return data.links;
}

export async function revokeLink(
	baseUrl: string,
	key: string,
	id: string,
): Promise<void> {
	await request(baseUrl, `/links/${encodeURIComponent(id)}`, {
		method: "DELETE",
		apiKey: key,
	});
}

export interface AccountTunnel {
	subdomain: string | null;
	url: string;
	protocol: "http" | "tcp";
	localPort: number | null;
	publicPort?: number;
	deviceName: string;
	connectedAt: string;
	basicAuth: boolean;
}

/** Every live tunnel of the signed-in account, on all its machines. */
export async function listAccountTunnels(
	baseUrl: string,
	accessToken: string,
): Promise<AccountTunnel[]> {
	const data = await request<{ tunnels: AccountTunnel[] }>(
		baseUrl,
		"/tunnels",
		{
			apiKey: accessToken,
		},
	);
	return data.tunnels;
}
