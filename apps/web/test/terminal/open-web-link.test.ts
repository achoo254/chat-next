import { afterEach, describe, expect, it, vi } from "vitest";
import { openWebLink } from "../../src/terminal/open-web-link.ts";

describe("a link in the terminal's text", () => {
	afterEach(() => vi.restoreAllMocks());

	it("opens a web address in a new tab, cut off from this page", () => {
		const open = vi.spyOn(window, "open").mockReturnValue(null);
		expect(openWebLink("https://accounts.google.com/o/oauth2/v2/auth?client_id=a&state=b")).toBe(true);
		expect(open).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?client_id=a&state=b", "_blank", "noopener,noreferrer");
		expect(openWebLink("http://localhost:8765/callback")).toBe(true);
	});

	it.each(["javascript:alert(1)", "file:///etc/passwd", "data:text/html,<b>x</b>", "vscode://open", "not a url", ""])("ignores %s", (uri) => {
		const open = vi.spyOn(window, "open").mockReturnValue(null);
		expect(openWebLink(uri)).toBe(false);
		expect(open).not.toHaveBeenCalled();
	});
});
