/** Fetch wrapper for Tunelo server API — prepends server URL, manages CSRF token */

import { DEFAULT_SERVER_URL } from "../../default-server.js";

function getServerUrl(): string {
	// In browser env, use injected window var or env var or default
	if (typeof window !== "undefined") {
		const w = window as Window & { __TUNELO_SERVER_URL__?: string };
		if (w.__TUNELO_SERVER_URL__) return w.__TUNELO_SERVER_URL__;
	}
	return DEFAULT_SERVER_URL;
}

let csrfToken: string | null = null;

/** Fetch CSRF token from server on first use */
async function ensureCsrfToken(): Promise<void> {
	if (csrfToken !== null) return;
	try {
		const res = await fetch(`${getServerUrl()}/api/auth/csrf`, {
			credentials: "include",
		});
		if (res.ok) {
			const data = (await res.json()) as { token?: string };
			csrfToken = data.token ?? "";
		} else {
			csrfToken = "";
		}
	} catch {
		csrfToken = "";
	}
}

export type ApiResponse<T> =
	| { ok: true; data: T; status: number }
	| { ok: false; error: string; status: number };

/** Core fetch wrapper — prepends server URL, includes credentials + CSRF header */
export async function apiFetch<T>(
	path: string,
	options: RequestInit = {},
): Promise<ApiResponse<T>> {
	const method = (options.method ?? "GET").toUpperCase();
	const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method);

	if (mutating) {
		await ensureCsrfToken();
	}

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		...(options.headers as Record<string, string> | undefined),
	};

	if (mutating && csrfToken) {
		headers["X-CSRF-Token"] = csrfToken;
	}

	try {
		const res = await fetch(`${getServerUrl()}${path}`, {
			...options,
			credentials: "include",
			headers,
		});

		// Auto-redirect to login on 401 (only in browser)
		if (res.status === 401 && typeof window !== "undefined") {
			const currentPath = window.location.pathname;
			if (currentPath !== "/login" && currentPath !== "/signup") {
				window.location.href = "/login";
			}
			return { ok: false, error: "Unauthorized", status: 401 };
		}

		if (!res.ok) {
			let error = `HTTP ${res.status}`;
			try {
				const body = (await res.json()) as { error?: string; message?: string };
				error = body.error ?? body.message ?? error;
			} catch {
				// ignore parse errors
			}
			return { ok: false, error, status: res.status };
		}

		// 204 No Content
		if (res.status === 204) {
			return { ok: true, data: null as T, status: 204 };
		}

		const data = (await res.json()) as T;
		return { ok: true, data, status: res.status };
	} catch (err) {
		const message = err instanceof Error ? err.message : "Network error";
		return { ok: false, error: message, status: 0 };
	}
}

/** Invalidate cached CSRF token (call after logout) */
export function clearCsrfToken(): void {
	csrfToken = null;
}
