// Why a login failed, as a code the engine can act on. The library's messages can embed a raw
// server response, so they are read here and never sent: only the code leaves the process.
//
// zca-js 2.3.0 throws ZaloApiError (its name is "ZcaApiError") for both a session Zalo refused and
// a Zalo fault. The cookie login (Zalo.loginCookie) fails as:
//   - getLoginInfo answered 200 but its data did not decrypt to an object: "Đăng nhập thất bại"
//   - the login info has no secret key: "Khởi tạo ngữ cảnh thất bại."
//   - getLoginInfo or getServerInfo answered non-200: "Failed to fetch login info: <status text>",
//     "Failed to fetch server info: ..."; "Missing signkey" and "Failed to encrypt params" are local.
// A 200 without usable data is the shape a dead cookie is expected to take; it has not been seen
// on a real account yet, so the engine only counts it as revoked when it repeats over time.

/** Session refused by Zalo: counts toward "the account needs to sign in again". */
export const SESSION_REJECTED = "session_rejected";
/** Zalo answered with an HTTP error or could not be used: try again later. */
export const ZALO_UNAVAILABLE = "zalo_unavailable";
/** The connection to Zalo failed (DNS, TCP, TLS, timeout, egress guard). */
export const NETWORK_ERROR = "network_error";
/** The session handed to login_session is not a session. */
export const BAD_SESSION = "bad_session";
/** Anything else. */
export const LOGIN_FAILED = "login_failed";

const REJECTED_MESSAGES = new Set(["Đăng nhập thất bại", "Khởi tạo ngữ cảnh thất bại."]);
const REFUSED_STATUS = new Set(["Unauthorized", "Forbidden"]);
const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);

/** Marks the session that login_session was given as unusable. */
export class BadSessionError extends Error {
	constructor() {
		super("bad session");
		this.name = "BadSessionError";
	}
}

/** The code for an error thrown by a login. */
export function loginFailureReason(error) {
	if (error instanceof BadSessionError) return BAD_SESSION;
	if (error === null || typeof error !== "object") return LOGIN_FAILED;
	if (error.name === "ZcaApiError") {
		const message = typeof error.message === "string" ? error.message : "";
		if (REJECTED_MESSAGES.has(message)) return SESSION_REJECTED;
		const loginInfo = "Failed to fetch login info: ";
		if (message.startsWith(loginInfo)) return REFUSED_STATUS.has(message.slice(loginInfo.length)) ? SESSION_REJECTED : ZALO_UNAVAILABLE;
		if (message.startsWith("Failed to fetch") || message === "Missing signkey" || message.startsWith("Failed to encrypt")) return ZALO_UNAVAILABLE;
		return LOGIN_FAILED;
	}
	return isNetworkError(error) ? NETWORK_ERROR : LOGIN_FAILED;
}

/** Whether an error is the connection to Zalo failing (DNS, TCP, TLS, timeout, egress guard). */
export function isNetworkError(error) {
	if (error === null || typeof error !== "object") return false;
	if (error.name === "AbortError" || error.name === "TimeoutError") return true;
	const code = error.code ?? error.cause?.code;
	if (typeof code === "string" && NETWORK_CODES.has(code)) return true;
	// fetch() fails with a TypeError ("fetch failed") whose cause is the socket error.
	return error instanceof TypeError && error.cause !== undefined;
}
