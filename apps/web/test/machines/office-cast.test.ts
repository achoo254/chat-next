// The office's cast: the 13 job titles of the studio, each with a name, a model, a colour and a home room;
// stable hashed colours for types no title claims, and the home rooms.
import { describe, expect, it } from "vitest";
import { castOf, homeRoomOf, nameFromType, nameHash, UNKNOWN_PALETTE } from "../../src/machines/office/office-cast.ts";
import { personName } from "../../src/machines/office/office-names.ts";
import { viMachines } from "../../src/machines/copy-vi.ts";

describe("the office's cast", () => {
	it("gives each known agent type its job title, model and colour, the same every call", () => {
		expect(castOf("planner")).toEqual({ key: "producerPm", accessory: "none", color: "#b07a4a", homeRoom: "PLANNING", model: "planner" });
		expect(castOf("tester").key).toBe("qaTester");
		expect(castOf("Code-Reviewer")).toEqual(castOf("code-reviewer"));
		expect(castOf("scout").key).toBe("techLead");
		expect(castOf("explore").key).toBe("techLead");
		expect(castOf("general-purpose").key).toBe("gameplayDeveloper");
		expect(castOf("debugger").key).toBe("gameplayDeveloper");
		expect(castOf("git-manager").key).toBe("backendDevops");
		expect(castOf("docs-seeker").key).toBe("researchAnalyst");
		expect(castOf("docs-manager").key).toBe("contentMarketing");
		expect(castOf("analytics-analyst").key).toBe("growthAnalytics");
		expect(castOf("brainstormer").key).toBe("gameDesigner");
		expect(viMachines.office.cast[castOf("planner").key ?? "producerPm"]).toBe("Quản lý dự án");
	});

	it("sends every security type to the Code & Security Reviewer", () => {
		for (const type of ["security", "security-auditor", "app-security", "cti-expert", "code-reviewer", "content-reviewer"]) {
			const cast = castOf(type);
			expect(cast.key, type).toBe("codeSecurityReviewer");
			expect(cast.homeRoom, type).toBe("AUDIT");
			expect(cast.model, type).toBe("code-reviewer");
		}
	});

	it("sends a type no title claims to the fallback model, with a hashed colour and a name built from the type", () => {
		const a = castOf("zebra-wrangler");
		expect(a.key).toBeNull();
		expect(a.model).toBe("fullstack-developer");
		expect(UNKNOWN_PALETTE).toContain(a.color);
		expect(castOf("zebra-wrangler")).toEqual(a);
		expect(nameHash("zebra-wrangler")).toBe(nameHash("zebra-wrangler"));
		expect(nameFromType("docs-manager")).toBe("Docs Manager");
		expect(nameFromType("")).toBe("");
		expect(() => castOf("")).not.toThrow();
		expect(UNKNOWN_PALETTE).toContain(castOf("").color);
	});

	it("claims unknown types by a word of their name, never by a chance substring", () => {
		expect(castOf("tech-lead").key).toBe("techLead");
		expect(castOf("web-security-scan").key).toBe("codeSecurityReviewer");
		expect(castOf("load-tester").key).toBe("qaTester");
		expect(castOf("market-copy-bot").key).toBe("contentMarketing");
		expect(castOf("market-research-bot").key).toBe("researchAnalyst");
		expect(castOf("smart-helper").key).toBeNull();
	});

	it("gives every one of the 13 titles a distinct colour and a distinct model", () => {
		const types = ["planner", "scout", "general-purpose", "git-manager", "brainstormer", "ui-ux-designer", "tester", "code-reviewer", "content-creator", "analytics-analyst", "researcher"];
		const casts = types.map((type) => castOf(type));
		expect(new Set(casts.map((c) => c.color)).size).toBe(casts.length);
		expect(new Set(casts.map((c) => c.model)).size).toBe(casts.length);
	});

	it("names employees with a number from the second of a type, and an unnamed type as a new hire", () => {
		const t = viMachines.office;
		const member = (agentType: string, ordinal: number) => ({ key: `${agentType}#${ordinal}`, agentType, ordinal, actorId: "x", desk: null, nested: false, firstEnteredAt: 0 });
		expect(personName(t, { kind: "employee", actor: null, member: member("scout", 1) })).toBe("Giám đốc Công nghệ");
		expect(personName(t, { kind: "employee", actor: null, member: member("scout", 2) })).toBe("Giám đốc Công nghệ 2");
		expect(personName(t, { kind: "employee", actor: null, member: member("zebra-wrangler", 1) })).toBe("Zebra Wrangler");
		expect(personName(t, { kind: "employee", actor: null, member: member("", 1) })).toBe("Nhân viên mới");
		expect(personName(t, { kind: "director", actor: null, member: null })).toBe("Giám đốc điều hành");
	});

	it("gives each title its home room: planning, library, audit, server; the rest work in WORK", () => {
		expect(homeRoomOf("planner")).toBe("PLANNING");
		expect(homeRoomOf("brainstormer")).toBe("PLANNING");
		expect(homeRoomOf("content-creator")).toBe("PLANNING");
		expect(homeRoomOf("researcher")).toBe("LIBRARY");
		expect(homeRoomOf("analytics-analyst")).toBe("LIBRARY");
		expect(homeRoomOf("code-reviewer")).toBe("AUDIT");
		expect(homeRoomOf("security-auditor")).toBe("AUDIT");
		expect(homeRoomOf("git-manager")).toBe("SERVER");
		expect(homeRoomOf("tester")).toBe("WORK");
		expect(homeRoomOf("scout")).toBe("WORK");
		expect(homeRoomOf("")).toBe("WORK");
	});
});
