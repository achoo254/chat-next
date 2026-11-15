// The one state mark (status-glyph.tsx, project-tree.ts): each AI's own running mark for Claude, Antigravity and
// Codex, the plain spinner for an AI without one; a workspace or project working with one AI shows that AI's mark,
// as its session rows do; the AI's terminal tab drops the state mark the AI prints in its title.
import { describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import { ThreadState, ThreadSummarySchema } from "@achoo254/chat-proto/remote/remote";
import { runningAi } from "../../src/machines/project-tree.ts";
import { aiTabTitle, runGlyph } from "../../src/machines/status-glyph.tsx";

describe("runGlyph", () => {
	it("gives each AI its own mark, by its id", () => {
		expect(runGlyph("claude")).toEqual({ icon: "run-claude", ai: "claude" });
		expect(runGlyph("antigravity")).toEqual({ icon: "run-antigravity", ai: "antigravity" });
		expect(runGlyph("codex")).toEqual({ icon: "run-codex", ai: "codex" });
	});

	it("falls back to the spinner, with no motion of an AI, for an unknown AI and for no AI", () => {
		expect(runGlyph("other-ai")).toEqual({ icon: "spinner", ai: undefined });
		expect(runGlyph(undefined)).toEqual({ icon: "spinner", ai: undefined });
	});
});

describe("runningAi: the mark of a workspace, a project or a loose folder", () => {
	const session = (provider: string, fields: Partial<{ state: ThreadState; backgroundTasks: number; terminalSession: number; archived: boolean }> = {}) => create(ThreadSummarySchema, { id: `${provider}-${Math.random()}`, provider, ...fields });

	it("is the one AI working there now, a turn or background work alike", () => {
		expect(runningAi([session("claude", { state: ThreadState.RUNNING }), session("codex")])).toBe("claude");
		expect(runningAi([session("claude", { backgroundTasks: 1 }), session("claude", { state: ThreadState.RUNNING })])).toBe("claude");
	});

	it("is none while nothing works (a terminal holding an AI at its prompt is not work), when several AIs work, or only archived ones do", () => {
		expect(runningAi([session("claude", { terminalSession: 3 })])).toBeUndefined();
		expect(runningAi([session("claude", { state: ThreadState.RUNNING }), session("codex", { state: ThreadState.RUNNING })])).toBeUndefined();
		expect(runningAi([session("claude", { state: ThreadState.RUNNING, archived: true })])).toBeUndefined();
	});
});

describe("aiTabTitle", () => {
	it("drops the state mark Claude Code prints before its title, idle or working", () => {
		expect(aiTabTitle("✳ Claude Code")).toBe("Claude Code");
		expect(aiTabTitle("⠐ Game thắp hương")).toBe("Game thắp hương");
		expect(aiTabTitle("✻ Sửa lỗi")).toBe("Sửa lỗi");
	});

	it("keeps a title without a Claude Code frame: a plain one, an emoji or an asterisk the title itself has", () => {
		expect(aiTabTitle("codex")).toBe("codex");
		expect(aiTabTitle("✨ Ý mới")).toBe("✨ Ý mới");
		expect(aiTabTitle("*nháp* sửa lỗi")).toBe("*nháp* sửa lỗi");
	});
});
