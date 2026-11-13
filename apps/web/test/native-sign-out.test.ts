// "Đăng xuất" in the native app (Settings, the account menu) wipes the
// device's data in the core, then must end the session on the server: its
// SignOut revokes the device's refresh token at the IdP, which ends the grant
// and takes the app off the account's "Nơi đang đăng nhập" at the IdP.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const token = vi.hoisted(() => ({ current: "tok-native", cleared: 0 }));

vi.mock("@capacitor/app", () => ({ App: { addListener: vi.fn() } }));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => "ios" } }));
vi.mock("@achoo254/capacitor-system-auth", () => ({ SystemAuth: { authenticate: vi.fn() } }));
vi.mock("../src/native/session-token.ts", () => ({
	sessionToken: () => token.current,
	loadSessionToken: () => Promise.resolve(token.current),
	saveSessionToken: (value: string) => {
		token.current = value;
		return Promise.resolve();
	},
	clearSessionToken: () => {
		token.current = "";
		token.cleared++;
		return Promise.resolve();
	},
}));

const { nativeChatOptions } = await import("../src/native/native-app.ts");

interface SentCall {
	readonly url: string;
	readonly authorization: string | null;
	/** The stored token when the request left. */
	readonly tokenAtSend: string;
}

let sent: SentCall[] = [];
let answer: () => Promise<Response>;

beforeEach(() => {
	token.current = "tok-native";
	token.cleared = 0;
	sent = [];
	answer = () => Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
	vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
		sent.push({ url: String(input), authorization: new Headers(init?.headers).get("Authorization"), tokenAtSend: token.current });
		return answer();
	});
	// jsdom cannot navigate; the restart is not what these tests are about.
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("native sign-out", () => {
	it("ends the session on the server with the device's bearer token, then forgets the token", async () => {
		nativeChatOptions().leave?.();
		await vi.waitFor(() => expect(token.cleared).toBe(1));
		expect(sent).toHaveLength(1);
		expect(sent[0]?.url.endsWith("/rpc/app.v1.AuthService/SignOut")).toBe(true);
		expect(sent[0]?.authorization).toBe("Bearer tok-native");
		expect(sent[0]?.tokenAtSend).toBe("tok-native");
		expect(token.current).toBe("");
	});

	it("still forgets the token when the server cannot be reached", async () => {
		answer = () => Promise.reject(new TypeError("offline"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		nativeChatOptions().leave?.();
		await vi.waitFor(() => expect(token.cleared).toBe(1));
		expect(sent).toHaveLength(1);
		expect(warn).toHaveBeenCalled();
	});
});
