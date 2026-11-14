// A running row's mark (session-row.tsx): each AI's own for Claude, Antigravity and Codex; the plain spinner for an AI
// without one and for rows that are no session (a workspace, a project).
import { describe, expect, it } from "vitest";
import { runGlyph } from "../../src/machines/session-row.tsx";

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
