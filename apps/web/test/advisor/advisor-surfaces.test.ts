// A service plugs into Advisor with one registerAdvisorSurface and a scope: its place is called in the
// user's language, only the fields it lists leave the page, and nothing in Advisor changes for it.
import { afterEach, describe, expect, it } from "vitest";
import { rememberCopy, setRouteContext } from "../../src/advisor/advisor-context.tsx";
import { AdvisorStore } from "../../src/advisor/advisor-store.ts";
import { allowedFields, MAX_FIELDS, registerAdvisorSurface, surfaceLabel } from "../../src/advisor/advisor-surfaces.ts";
import { whereOf } from "../../src/advisor/advisor-bubble.tsx";
import { attachmentsOf } from "../../src/advisor/use-advisor-presence.ts";

afterEach(() => setRouteContext({}));

describe("registering a surface", () => {
	it("names the place in the user's language and falls back to Vietnamese; an unknown place has no name", () => {
		registerAdvisorSurface({ id: "wiki", label: { vi: "trang wiki", en: "a wiki page" } });
		expect(surfaceLabel("", "wiki", "en")).toBe("a wiki page");
		expect(surfaceLabel("", "wiki", "zh-CN")).toBe("trang wiki");
		expect(surfaceLabel("", "nowhere", "vi")).toBe("");
		// A panel's own surface wins over its screen's.
		registerAdvisorSurface({ id: "wiki-edit", label: { vi: "soạn wiki" } });
		expect(surfaceLabel("wiki-edit", "wiki", "vi")).toBe("soạn wiki");
	});

	it("refuses an id or a field that is not a name, and more fields than the machine takes", () => {
		expect(() => registerAdvisorSurface({ id: "Bad Id", label: { vi: "x" } })).toThrow();
		expect(() => registerAdvisorSurface({ id: "ok", label: { vi: "x" }, fields: ["has space"] })).toThrow();
		const many = Array.from({ length: MAX_FIELDS + 1 }, (_, i) => `f${i}`);
		expect(() => registerAdvisorSurface({ id: "ok", label: { vi: "x" }, fields: many })).toThrow();
	});

	it("sends only the fields its surface lists", () => {
		registerAdvisorSurface({ id: "wiki", label: { vi: "trang wiki" }, fields: ["space", "page_kind"] });
		expect(allowedFields("", "wiki", { space: "docs", page_kind: "draft", user_email: "a@b.c" })).toEqual({ space: "docs", page_kind: "draft" });
		expect(allowedFields("", "unregistered", { space: "docs" })).toEqual({});
	});
});

describe("a copy on a registered surface", () => {
	it("carries the scope's fields to the machine, one line each, and drops a field that looks like a secret", () => {
		registerAdvisorSurface({ id: "wiki", label: { vi: "trang wiki" }, fields: ["space", "page_kind", "note"] });
		setRouteContext({ screen: "wiki", fields: { space: "docs", page_kind: "draft\nwith a break", note: "token ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8" } });
		const store = new AdvisorStore();
		expect(rememberCopy("some text", document.body, store)).toBe(true);
		const copy = store.snapshot().copies[0];
		if (copy === undefined) throw new Error("no copy kept");
		expect(copy.context.fields).toEqual({ space: "docs", page_kind: "draft\nwith a break" });
		const sent = attachmentsOf([copy])[0];
		expect(sent?.context.screen).toBe("wiki");
		expect(sent?.context.fields).toEqual({ space: "docs", page_kind: "draft with a break" });
		expect(whereOf("en", copy.context)).toBe("trang wiki");
	});
});
