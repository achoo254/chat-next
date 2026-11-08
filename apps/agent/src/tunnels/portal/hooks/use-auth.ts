/** Auth hook — signup, login, TOTP verify, logout */

import { useState } from "react";
import { apiFetch, clearCsrfToken } from "../api/client.js";

export interface AuthUser {
	id: string;
	email: string;
	totpEnabled: boolean;
}

export interface SignupResult {
	userId: string;
	/** data URL for QR code */
	qrCodeUrl: string;
	/** base32 secret for manual entry */
	totpSecret: string;
}

export interface UseAuthReturn {
	user: AuthUser | null;
	loading: boolean;
	error: string | null;
	signup: (email: string, password: string) => Promise<SignupResult | null>;
	verifyTotp: (userId: string, code: string) => Promise<boolean>;
	login: (
		email: string,
		password: string,
		totpCode: string,
	) => Promise<boolean>;
	logout: () => Promise<void>;
	fetchMe: () => Promise<void>;
	clearError: () => void;
}

export function useAuth(): UseAuthReturn {
	const [user, setUser] = useState<AuthUser | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	function clearError(): void {
		setError(null);
	}

	async function fetchMe(): Promise<void> {
		const res = await apiFetch<AuthUser>("/api/auth/me");
		if (res.ok) setUser(res.data);
	}

	async function signup(
		email: string,
		password: string,
	): Promise<SignupResult | null> {
		setLoading(true);
		setError(null);
		try {
			const res = await apiFetch<SignupResult>("/api/auth/signup", {
				method: "POST",
				body: JSON.stringify({ email, password }),
			});
			if (!res.ok) {
				setError(res.error);
				return null;
			}
			return res.data;
		} finally {
			setLoading(false);
		}
	}

	async function verifyTotp(userId: string, code: string): Promise<boolean> {
		setLoading(true);
		setError(null);
		try {
			const res = await apiFetch<{ ok: boolean }>("/api/auth/totp/verify", {
				method: "POST",
				body: JSON.stringify({ userId, code }),
			});
			if (!res.ok) {
				setError(res.error);
				return false;
			}
			return true;
		} finally {
			setLoading(false);
		}
	}

	async function login(
		email: string,
		password: string,
		totpCode: string,
	): Promise<boolean> {
		setLoading(true);
		setError(null);
		try {
			const res = await apiFetch<AuthUser>("/api/auth/login", {
				method: "POST",
				body: JSON.stringify({ email, password, totpCode }),
			});
			if (!res.ok) {
				setError(res.error);
				return false;
			}
			setUser(res.data);
			return true;
		} finally {
			setLoading(false);
		}
	}

	async function logout(): Promise<void> {
		setLoading(true);
		try {
			await apiFetch("/api/auth/logout", { method: "POST" });
			clearCsrfToken();
			setUser(null);
		} finally {
			setLoading(false);
		}
	}

	return {
		user,
		loading,
		error,
		signup,
		verifyTotp,
		login,
		logout,
		fetchMe,
		clearError,
	};
}
