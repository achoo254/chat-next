import assert from "node:assert/strict";
import test from "node:test";
import { BadSessionError, loginFailureReason } from "../src/login-failure.mjs";

/** An error shaped like zca-js 2.3.0's ZaloApiError. */
function zcaError(message) {
	const error = new Error(message);
	error.name = "ZcaApiError";
	error.code = null;
	return error;
}

test("a session Zalo refuses is session_rejected", () => {
	assert.equal(loginFailureReason(zcaError("Đăng nhập thất bại")), "session_rejected");
	assert.equal(loginFailureReason(zcaError("Khởi tạo ngữ cảnh thất bại.")), "session_rejected");
	assert.equal(loginFailureReason(zcaError("Failed to fetch login info: Unauthorized")), "session_rejected");
	assert.equal(loginFailureReason(zcaError("Failed to fetch login info: Forbidden")), "session_rejected");
});

test("a Zalo fault is zalo_unavailable, not a refusal", () => {
	for (const message of [
		"Failed to fetch login info: Service Unavailable",
		"Failed to fetch login info: Bad Gateway",
		"Failed to fetch server info: Internal Server Error",
		"Failed to fetch server info: maintenance",
		"Missing signkey",
		"Failed to encrypt params: x",
	]) {
		assert.equal(loginFailureReason(zcaError(message)), "zalo_unavailable", message);
	}
});

test("a broken connection is network_error", () => {
	const fetchFailed = new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNRESET" }) });
	assert.equal(loginFailureReason(fetchFailed), "network_error");
	assert.equal(loginFailureReason(Object.assign(new Error("x"), { code: "ENOTFOUND" })), "network_error");
	assert.equal(loginFailureReason(Object.assign(new Error("x"), { name: "AbortError" })), "network_error");
	assert.equal(loginFailureReason(new TypeError("fetch failed", { cause: new Error("connection refused by the egress guard") })), "network_error");
});

test("anything else stays generic and the bad session is named", () => {
	assert.equal(loginFailureReason(new BadSessionError()), "bad_session");
	assert.equal(loginFailureReason(zcaError("Something new")), "login_failed");
	assert.equal(loginFailureReason(new Error("Đăng nhập thất bại")), "login_failed"); // not the library's class
	assert.equal(loginFailureReason(new TypeError("x is not a function")), "login_failed");
	assert.equal(loginFailureReason(undefined), "login_failed");
	assert.equal(loginFailureReason("text"), "login_failed");
});

test("the messages and class name match the bundled zca-js", async () => {
	const { readFile } = await import("node:fs/promises");
	const bundle = await readFile(new URL("../dist/zalo-sidecar.cjs", import.meta.url), "utf8");
	// The same text the classifier matches, in the escaped form esbuild writes.
	assert.equal("Đăng nhập thất bại", "\u0110\u0103ng nh\u1EADp th\u1EA5t b\u1EA1i");
	assert.equal("Khởi tạo ngữ cảnh thất bại.", "Kh\u1EDFi t\u1EA1o ng\u1EEF c\u1EA3nh th\u1EA5t b\u1EA1i.");
	for (const literal of [
		'this.name = "ZcaApiError"',
		String.raw`throw new ZaloApiError("\u0110\u0103ng nh\u1EADp th\u1EA5t b\u1EA1i")`,
		String.raw`throw new ZaloApiError("Kh\u1EDFi t\u1EA1o ng\u1EEF c\u1EA3nh th\u1EA5t b\u1EA1i.")`,
		'throw new ZaloApiError("Failed to fetch login info: " + response.statusText)',
		'throw new ZaloApiError("Failed to fetch server info: " + response.statusText)',
	]) {
		assert.ok(bundle.includes(literal), `bundle no longer contains ${literal}`);
	}
});
