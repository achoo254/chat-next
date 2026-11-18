// A verdict's page leads back to the session it came from: the tab it showed
// in when that session is on screen, the session itself when something else
// (another session, a settings screen) is.
import { describe, expect, it } from "vitest";
import { pageOfSession } from "../../src/advisor/use-advisor-presence.ts";

describe("pageOfSession", () => {
	it("keeps the tab and query of the session on screen", () => {
		expect(pageOfSession("7", "abc", "/ai/7/s/abc/terminal", "?tab=2")).toBe("/ai/7/s/abc/terminal?tab=2");
		expect(pageOfSession("7", "abc", "/ai/7/s/abc", "")).toBe("/ai/7/s/abc");
	});

	it("names the session itself when another session shows", () => {
		expect(pageOfSession("7", "abc", "/ai/7/s/other/office", "?x=1")).toBe("/ai/7/s/abc");
	});

	it("names the session itself when another screen shows, and does not match a longer id", () => {
		expect(pageOfSession("7", "abc", "/settings/advisor", "")).toBe("/ai/7/s/abc");
		expect(pageOfSession("7", "abc", "/ai/7/s/abcd/terminal", "")).toBe("/ai/7/s/abc");
	});
});
