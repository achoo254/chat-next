// What a QR login shows from the server's steps and errors (qr-login-model.ts).
import { describe, expect, it } from "vitest";
import { BridgeError } from "../src/messaging/settings/bridge-api.ts";
import { isEnded, isSafeQrDataUrl, limitWaitSeconds, MAX_QR_URL_LENGTH, RECEIVE_ONLY_APPS, statusOfError, viewOfStep } from "../src/messaging/settings/qr-login-model.ts";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("isSafeQrDataUrl", () => {
	it("accepts a base64 PNG data: URL", () => {
		expect(isSafeQrDataUrl(PNG)).toBe(true);
	});

	it.each([
		["empty", ""],
		["another type", "data:image/svg+xml;base64,PHN2Zz4="],
		["not base64", "data:image/png,<svg>"],
		["a space", "data:image/png;base64,iVBOR w0="],
		["a newline", "data:image/png;base64,iVBOR\nw0="],
		["a link", "https://example.test/qr.png"],
		["upper-case scheme", "DATA:image/png;base64,iVBORw0KGgo="],
		["a trailing quote", `${PNG}"`],
	])("refuses %s", (_name, url) => {
		expect(isSafeQrDataUrl(url)).toBe(false);
	});

	it("refuses a URL at or over the size bound", () => {
		const prefix = "data:image/png;base64,";
		expect(isSafeQrDataUrl(prefix + "A".repeat(MAX_QR_URL_LENGTH - prefix.length - 1))).toBe(true);
		expect(isSafeQrDataUrl(prefix + "A".repeat(MAX_QR_URL_LENGTH - prefix.length))).toBe(false);
	});
});

describe("viewOfStep", () => {
	const qr = (prompt: string) => ({ kind: "qr" as const, loginId: "l", prompt });

	it("is preparing before the first code, and refreshing after one expired", () => {
		expect(viewOfStep(qr(""), false)).toEqual({ status: "preparing", image: "" });
		expect(viewOfStep(qr(""), true)).toEqual({ status: "refreshing", image: "" });
	});

	it("shows a safe code and refuses another", () => {
		expect(viewOfStep(qr(PNG), false)).toEqual({ status: "scan", image: PNG });
		expect(viewOfStep(qr("javascript:alert(1)"), true)).toEqual({ status: "failed", image: "" });
	});

	it("waits for the phone on confirm, and fails on a step it does not expect", () => {
		expect(viewOfStep({ kind: "confirm", loginId: "l", prompt: "Confirm" }, true)).toEqual({ status: "confirm", image: "" });
		expect(viewOfStep({ kind: "input", loginId: "l", prompt: "", fields: [] }, false)).toEqual({ status: "failed", image: "" });
	});
});

describe("statusOfError", () => {
	it.each([
		[new BridgeError("wrong_input", "qr_declined"), "declined"],
		[new BridgeError("wrong_input", "qr_expired"), "expired"],
		[new BridgeError("wrong_input", "login_expired"), "expired"],
		[new BridgeError("wrong_input", "something_else"), "failed"],
		[new BridgeError("not_found"), "expired"],
		[new BridgeError("rate_limited"), "limited"],
		[new BridgeError("account_taken"), "taken"],
		[new BridgeError("reauth"), "failed"],
		[new BridgeError("network"), "network"],
		[new BridgeError("other"), "failed"],
	] as const)("maps %s to %s", (error, status) => {
		expect(statusOfError(error)).toBe(status);
	});

	it("ends the login on everything but a network error", () => {
		expect(isEnded("network")).toBe(false);
		expect(isEnded("scan")).toBe(false);
		expect(isEnded("declined")).toBe(true);
		expect(isEnded("limited")).toBe(true);
	});
});

describe("limitWaitSeconds", () => {
	it("takes the wait the server asked for", () => {
		expect(limitWaitSeconds(new BridgeError("rate_limited", "13"))).toBe(13);
		expect(limitWaitSeconds(new BridgeError("rate_limited", "600"))).toBe(600);
	});

	it("caps an absurd hint and falls back to the adapter's cool-down without one", () => {
		expect(limitWaitSeconds(new BridgeError("rate_limited", "999999"))).toBe(3600);
		expect(limitWaitSeconds(new BridgeError("rate_limited"))).toBe(20);
		expect(limitWaitSeconds(new BridgeError("rate_limited", "0"))).toBe(20);
		expect(limitWaitSeconds(new BridgeError("rate_limited", "soon"))).toBe(20);
	});
});

describe("RECEIVE_ONLY_APPS", () => {
	it("lists Zalo, which Chat only reads from", () => {
		expect(RECEIVE_ONLY_APPS.has("zalo")).toBe(true);
		expect(RECEIVE_ONLY_APPS.has("telegram")).toBe(false);
	});
});
