// Glue of the Capacitor build (VITE_NATIVE=true): every request carries the
// session token as a bearer token instead of the web's HttpOnly cookie, and
// the web's sign-in and sign-out routes (/auth/login links, the
// /auth/logout form), which do not exist inside the app, run natively. The
// screens stay those of the web app. Loaded only by the native build
// (main.tsx), so none of this reaches the web bundle.
import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { SIGN_OUT_PATH } from "@achoo254/chat-core";
import { SystemAuth } from "@shared-next/capacitor-system-auth";
import type { RpcFetch } from "../api/client.ts";
import type { NativeChatOptions } from "../messaging/data/web-client.ts";
import { NativeSignInError, safeReturnTo, signInNative, signOutNative, type NativePlatform, type SignInFailure } from "./native-sign-in.ts";
import { clearSessionToken, loadSessionToken, saveSessionToken, sessionToken } from "./session-token.ts";

const APP_VERSION = import.meta.env.VITE_APP_VERSION || "dev";

/** The platform the app runs on; Capacitor reports "web" only outside the app. */
export function nativePlatform(): NativePlatform {
	return Capacitor.getPlatform() === "android" ? "android" : "ios";
}

function deviceName(platform: NativePlatform): string {
	if (platform === "android") return "Android";
	return /iPad/.test(navigator.userAgent) ? "iPad" : "iPhone";
}

/** fetch for the server's /rpc: the bearer token rides along, cookies never do. */
export const nativeFetch: RpcFetch = (input, init) => {
	const headers = new Headers(init?.headers);
	const token = sessionToken();
	if (token !== "") headers.set("Authorization", `Bearer ${token}`);
	return fetch(input, { ...init, headers, credentials: "omit" });
};

/** How the chat client reaches the server as this app (web-client.ts). */
export function nativeChatOptions(): NativeChatOptions {
	return {
		native: { sessionToken: sessionToken(), client: nativePlatform() },
		appVersion: APP_VERSION,
		// The core already ended the session (SignOut) and wiped this device's data.
		leave: () => void restartSignedOut(),
		onForegroundChange: subscribeAppState,
	};
}

/** Foreground changes of the app (the WebView's visibility does not follow them on Android). */
export function subscribeAppState(listener: (foreground: boolean) => void): () => void {
	const handle = CapacitorApp.addListener("appStateChange", (state) => listener(state.isActive));
	return () => {
		void handle.then((h) => h.remove());
	};
}

/** The session ended (signed out, revoked, expired): forget its token. */
export function forgetSession(): Promise<void> {
	return clearSessionToken();
}

/** Forgets the session token and restarts at the welcome screen. */
async function restartSignedOut(): Promise<void> {
	await clearSessionToken();
	window.location.replace("/");
}

/** Ends the session on the server (the web's /auth/logout form), then restarts signed out. */
async function signOutAndRestart(): Promise<void> {
	await signOutNative(nativeFetch);
	await restartSignedOut();
}

const FAILURE_COPY: Record<"vi" | "en", Record<SignInFailure, string>> = {
	vi: {
		failed: "Đăng nhập chưa xong. Hãy thử lại.",
		unavailable: "Chưa kết nối được tới máy chủ đăng nhập. Hãy thử lại sau.",
		limited: "Đang có quá nhiều tài khoản mới. Hãy thử lại sau ít phút.",
	},
	en: {
		failed: "Sign-in did not finish. Please try again.",
		unavailable: "Could not reach the sign-in server. Please try again later.",
		limited: "Too many new accounts right now. Please try again in a few minutes.",
	},
};

function failureMessage(kind: SignInFailure): string {
	const lang = document.documentElement.lang.toLowerCase().startsWith("en") ? "en" : "vi";
	return FAILURE_COPY[lang][kind];
}

let signingIn = false;

/** Runs the native sign-in for a web /auth/login link and opens return_to once signed in. */
async function signInFromLink(href: string): Promise<void> {
	if (signingIn) return;
	signingIn = true;
	const query = new URL(href, window.location.origin).searchParams;
	const platform = nativePlatform();
	try {
		const done = await signInNative(
			{
				rpcFetch: nativeFetch,
				authenticate: async (url, scheme) => (await SystemAuth.authenticate({ url, callback: { scheme } })).url,
				saveToken: saveSessionToken,
				platform,
				deviceName: deviceName(platform),
				appVersion: APP_VERSION,
			},
			{ locale: query.get("locale") ?? "", create: query.get("prompt") === "create", reauth: query.get("reauth") === "1" },
		);
		if (!done) return;
		// A fresh start picks the new session up everywhere, the worker included.
		window.location.replace(safeReturnTo(query.get("return_to"), window.location.origin));
	} catch (err) {
		const kind = err instanceof NativeSignInError ? err.kind : "unavailable";
		console.warn("native sign-in:", err instanceof Error ? err.message : String(err));
		window.alert(failureMessage(kind));
	} finally {
		signingIn = false;
	}
}

/** The path of a same-app link or form target, or null for anything else. */
function appPath(raw: string | null): string | null {
	if (raw === null || !raw.startsWith("/") || raw.startsWith("//")) return null;
	return raw;
}

/**
 * Turns the web's sign-in links and sign-out forms into the native flows,
 * wherever a screen renders them.
 */
function interceptAuthRoutes(): void {
	document.addEventListener(
		"click",
		(event) => {
			if (event.defaultPrevented || event.button !== 0) return;
			const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
			const href = appPath(anchor?.getAttribute("href") ?? null);
			if (href === null || !href.startsWith("/auth/login")) return;
			event.preventDefault();
			void signInFromLink(href);
		},
		true,
	);
	document.addEventListener(
		"submit",
		(event) => {
			const form = event.target;
			if (!(form instanceof HTMLFormElement) || appPath(form.getAttribute("action")) !== SIGN_OUT_PATH) return;
			event.preventDefault();
			void signOutAndRestart();
		},
		true,
	);
}

/** Starts the native layer before the app renders: reads the stored session token and takes over the auth routes. */
export async function startNative(): Promise<void> {
	await loadSessionToken();
	interceptAuthRoutes();
}
