import { describe, expect, it } from "vitest";
import { Code, ConnectError } from "@connectrpc/connect";
import { quickReactions, reactionTaken } from "../../src/messaging/ui/bridge-reactions.ts";
import { isReactionRefused } from "../../src/messaging/ui/reaction-refused.ts";

describe("reactions of a chat synced with another app", () => {
	it("takes any emoji in a plain chat", () => {
		expect(reactionTaken(undefined, "😮")).toBe(true);
	});
	it("takes only the emoji Telegram has", () => {
		expect(reactionTaken("telegram", "😮")).toBe(false);
		expect(reactionTaken("telegram", "👍")).toBe(true);
		expect(reactionTaken("telegram", "❤️")).toBe(true);
		expect(reactionTaken("telegram", "❤‍🔥")).toBe(true);
	});
	it("takes only the emoji Zalo has", () => {
		expect(reactionTaken("zalo", "😮")).toBe(true);
		expect(reactionTaken("zalo", "❤️")).toBe(true);
		expect(reactionTaken("zalo", "🦄")).toBe(false);
		expect(quickReactions("zalo", ["👍", "❤️", "😂", "😮", "🙏"])).toEqual(["👍", "❤️", "😂", "😮", "🙏"]);
	});
	it("swaps a quick-row emoji Telegram lacks for its closest, once", () => {
		const row = ["👍", "❤️", "😂", "😮", "🙏"];
		expect(quickReactions(undefined, row)).toEqual(row);
		expect(quickReactions("telegram", row)).toEqual(["👍", "❤️", "🤣", "😱", "🙏"]);
		expect(quickReactions("telegram", ["😂", "🤣"])).toEqual(["🤣"]);
	});
	it("tells the server's refusal of an emoji from any other failure", () => {
		expect(isReactionRefused(new ConnectError("reaction_not_accepted: telegram does not take this emoji", Code.InvalidArgument))).toBe(true);
		expect(isReactionRefused(new ConnectError("reaction must be one emoji", Code.InvalidArgument))).toBe(false);
		expect(isReactionRefused(new Error("network"))).toBe(false);
		// The check reads the code by value (no Connect import on the startup path): another code is not a refusal.
		expect(isReactionRefused(new ConnectError("reaction_not_accepted: x", Code.FailedPrecondition))).toBe(false);
	});
});
