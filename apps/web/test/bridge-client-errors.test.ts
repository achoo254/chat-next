// The kind of a failed bridge call (bridge-client.ts bridgeError): what the
// QR login tells apart, a server it could not reach and a call it aborted.
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import { bridgeError } from "../src/messaging/settings/bridge-client.ts";

describe("bridgeError", () => {
	it("calls a failed fetch, a gateway error and a deadline a network error", () => {
		expect(bridgeError(ConnectError.from(new TypeError("Failed to fetch"))).kind).toBe("network");
		expect(bridgeError(new ConnectError("bad gateway", Code.Unavailable)).kind).toBe("network");
		expect(bridgeError(new ConnectError("deadline", Code.DeadlineExceeded)).kind).toBe("network");
	});

	it("keeps a plain server error apart from a network error", () => {
		expect(bridgeError(new ConnectError("zalo: the login process stopped", Code.Unknown)).kind).toBe("other");
	});

	it("calls an aborted call canceled", () => {
		const abort = new Error("aborted");
		abort.name = "AbortError";
		expect(bridgeError(ConnectError.from(abort)).kind).toBe("canceled");
	});

	it("reads the code of a refused QR login", () => {
		const declined = bridgeError(new ConnectError("wrong_input: qr_declined: the login was declined on the phone, start it again", Code.InvalidArgument));
		expect(declined.kind).toBe("wrong_input");
		expect(declined.detail).toBe("qr_declined");
		expect(bridgeError(new ConnectError("too many sign-in attempts; try again later", Code.ResourceExhausted)).kind).toBe("rate_limited");
	});

	it("reads how long a refused login start must wait", () => {
		const limited = bridgeError(new ConnectError("rate_limited: too many sign-in attempts; retry_after=13", Code.ResourceExhausted));
		expect(limited.kind).toBe("rate_limited");
		expect(limited.detail).toBe("13");
		expect(bridgeError(new ConnectError("too many sign-in attempts; try again later", Code.ResourceExhausted)).detail).toBe("");
	});
});
