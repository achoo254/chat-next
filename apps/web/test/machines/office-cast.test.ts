// The office's cast: fixed names, accessories and colours per agent type,
// stable hashed colours for unknown types, and the home rooms.
import { describe, expect, it } from "vitest";
import { castOf, homeRoomOf, nameFromType, nameHash, UNKNOWN_PALETTE } from "../../src/machines/office/office-cast.ts";
import { personName } from "../../src/machines/office/office-names.ts";
import { viMachines } from "../../src/machines/copy-vi.ts";

describe("the office's cast", () => {
	it("gives each known agent type its name, accessory and colour, the same every call", () => {
		expect(castOf("scout")).toEqual({ key: "scout", accessory: "magnifier", color: "#2a9d8f", homeRoom: "WORK" });
		expect(castOf("tester").accessory).toBe("hardhat");
		expect(castOf("code-reviewer").accessory).toBe("glasses");
		expect(castOf("Code-Reviewer")).toEqual(castOf("code-reviewer"));
		expect(viMachines.office.cast[castOf("scout").key ?? "scout"]).toBe("Tí Trinh Sát");
	});

	it("hashes an unknown type into the fixed palette, stably, and builds its name from the type", () => {
		const a = castOf("docs-manager");
		expect(a.key).toBeNull();
		expect(UNKNOWN_PALETTE).toContain(a.color);
		expect(castOf("docs-manager")).toEqual(a);
		expect(nameHash("docs-manager")).toBe(nameHash("docs-manager"));
		expect(nameFromType("docs-manager")).toBe("Docs Manager");
		expect(nameFromType("")).toBe("");
		expect(() => castOf("")).not.toThrow();
		expect(UNKNOWN_PALETTE).toContain(castOf("").color);
	});

	it("names employees with a number from the second of a type, and an unnamed type as a new hire", () => {
		const t = viMachines.office;
		const member = (agentType: string, ordinal: number) => ({ key: `${agentType}#${ordinal}`, agentType, ordinal, actorId: "x", desk: null, nested: false, firstEnteredAt: 0 });
		expect(personName(t, { kind: "employee", actor: null, member: member("scout", 1) })).toBe("Tí Trinh Sát");
		expect(personName(t, { kind: "employee", actor: null, member: member("scout", 2) })).toBe("Tí Trinh Sát 2");
		expect(personName(t, { kind: "employee", actor: null, member: member("docs-manager", 1) })).toBe("Docs Manager");
		expect(personName(t, { kind: "employee", actor: null, member: member("", 1) })).toBe("Nhân viên mới");
		expect(personName(t, { kind: "director", actor: null, member: null })).toBe("Giám đốc");
	});

	it("gives planner, researcher, code-reviewer, tester and security types a home room; the rest work in WORK", () => {
		expect(homeRoomOf("planner")).toBe("PLANNING");
		expect(homeRoomOf("researcher")).toBe("LIBRARY");
		expect(homeRoomOf("code-reviewer")).toBe("AUDIT");
		expect(homeRoomOf("tester")).toBe("QA");
		expect(homeRoomOf("security-auditor")).toBe("SECURITY");
		expect(homeRoomOf("app-security")).toBe("SECURITY");
		expect(homeRoomOf("scout")).toBe("WORK");
		expect(homeRoomOf("")).toBe("WORK");
	});
});
