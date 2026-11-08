import { describe, expect, test } from "vitest";
import { CONFIRM_TOKEN_TTL_MS, ConfirmTokens } from "./confirm-tokens.js";

describe("ConfirmTokens", () => {
	test("a token works once, for its own action", () => {
		const tokens = new ConfirmTokens();
		const { confirm_token } = tokens.issue("revoke a");
		expect(() => tokens.consume(confirm_token, "revoke b")).toThrow(
			/another input/,
		);
		tokens.consume(confirm_token, "revoke a");
		expect(() => tokens.consume(confirm_token, "revoke a")).toThrow(
			/already used/,
		);
	});

	test("refuses a missing or expired token", () => {
		let now = 1_000;
		const tokens = new ConfirmTokens(() => now);
		expect(() => tokens.consume(undefined, "revoke a")).toThrow(/dry_run=true/);
		const { confirm_token } = tokens.issue("revoke a");
		now += CONFIRM_TOKEN_TTL_MS;
		expect(() => tokens.consume(confirm_token, "revoke a")).toThrow(/expired/);
	});
});
