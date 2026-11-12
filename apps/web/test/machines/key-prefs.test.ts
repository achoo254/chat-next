import { describe, expect, it } from "vitest";
import { phraseText, speechLang } from "../../src/terminal/dictation.ts";
import { addCustom, allKeys, comboLabel, comboSequence, DEFAULT_ORDER, EMPTY_PREFS, moveKey, parsePrefs, removeCustom, rowOf, toggleHidden } from "../../src/terminal/key-prefs.ts";

const none = { ctrl: false, alt: false, shift: false };

describe("the phone key row as a device keeps it", () => {
	it("falls back to the default row for nothing kept or anything unreadable", () => {
		expect(rowOf(parsePrefs(null))).toEqual(DEFAULT_ORDER);
		expect(rowOf(parsePrefs("{oops"))).toEqual(DEFAULT_ORDER);
		expect(rowOf(parsePrefs(JSON.stringify({ order: 3, hidden: "x", custom: [{ id: "bad" }] })))).toEqual(DEFAULT_ORDER);
	});

	it("hides, shows, moves, and keeps keys a later version adds", () => {
		let p = toggleHidden(EMPTY_PREFS, "esc");
		expect(rowOf(p)[0]).toBe("tab");
		p = toggleHidden(p, "esc");
		expect(rowOf(p)[0]).toBe("esc");
		p = moveKey(p, "tab", -1);
		expect(rowOf(p).slice(0, 2)).toEqual(["tab", "esc"]);
		expect(moveKey(p, "tab", -1)).toBe(p);
		// A kept order missing a built-in key still shows it, at the end.
		const old = parsePrefs(JSON.stringify({ order: ["esc", "tab", "gone"], hidden: [], custom: [] }));
		expect(allKeys(old).slice(0, 2)).toEqual(["esc", "tab"]);
		expect(allKeys(old)).not.toContain("gone");
		expect(allKeys(old)).toContain("ctrl-r");
	});

	it("adds the user's own keys to the end of the row and deletes them everywhere", () => {
		let p = addCustom(EMPTY_PREFS, "ls", "ls\r", "c:1");
		expect(rowOf(p).at(-1)).toBe("c:1");
		p = toggleHidden(p, "c:1");
		p = removeCustom(p, "c:1");
		expect(p.custom).toEqual([]);
		expect(p.hidden).toEqual([]);
		expect(allKeys(p)).not.toContain("c:1");
		expect(parsePrefs(JSON.stringify(addCustom(EMPTY_PREFS, "ls", "ls\r", "c:2"))).custom).toEqual([{ id: "c:2", label: "ls", send: "ls\r" }]);
	});
});

describe("combos as xterm sends them", () => {
	it("characters: Shift is the capital, Ctrl the control code, Alt ESC before it", () => {
		expect(comboSequence({ ...none, ctrl: true }, { kind: "char", ch: "c" })).toBe("\x03");
		expect(comboSequence({ ...none, alt: true }, { kind: "char", ch: "b" })).toBe("\x1bb");
		expect(comboSequence({ ...none, shift: true, alt: true }, { kind: "char", ch: "b" })).toBe("\x1bB");
		expect(comboSequence(none, { kind: "char", ch: "" })).toBe("");
	});

	it("cursor, editing and function keys carry the modifiers as a CSI parameter", () => {
		expect(comboSequence(none, { kind: "named", name: "up" })).toBe("\x1b[A");
		expect(comboSequence({ ...none, shift: true }, { kind: "named", name: "up" })).toBe("\x1b[1;2A");
		expect(comboSequence({ ...none, ctrl: true }, { kind: "named", name: "right" })).toBe("\x1b[1;5C");
		expect(comboSequence({ ...none, ctrl: true, shift: true }, { kind: "named", name: "delete" })).toBe("\x1b[3;6~");
		expect(comboSequence({ ...none, alt: true }, { kind: "named", name: "f1" })).toBe("\x1b[1;3P");
		expect(comboSequence({ ...none, shift: true }, { kind: "named", name: "tab" })).toBe("\x1b[Z");
		expect(comboSequence({ ...none, alt: true }, { kind: "named", name: "enter" })).toBe("\x1b\r");
	});

	it("labels a combo the way a keyboard prints it", () => {
		expect(comboLabel({ ctrl: true, alt: false, shift: true }, "K")).toBe("Ctrl+Shift+K");
	});
});

describe("dictation", () => {
	it("speaks the app's language and spaces phrases", () => {
		expect(speechLang("vi")).toBe("vi-VN");
		expect(speechLang("zh-CN")).toBe("zh-CN");
		expect(speechLang("en")).toBe("en-US");
		expect(phraseText(" xin chào ", true)).toBe("xin chào");
		expect(phraseText("lần nữa", false)).toBe(" lần nữa");
		expect(phraseText("  ", false)).toBe("");
	});
});
