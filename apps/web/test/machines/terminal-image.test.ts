import { describe, expect, it } from "vitest";
import { pathInput } from "../../src/terminal/terminal-image.ts";

describe("an image's saved path, typed into the terminal", () => {
	it("goes as a bracketed paste when the program asked for one, then a space", () => {
		expect(pathInput("/Users/a/p/.tunelo-attachments/2026-11-12/shot.png", true)).toBe("\x1b[200~/Users/a/p/.tunelo-attachments/2026-11-12/shot.png\x1b[201~ ");
		expect(pathInput("/home/a/x.png", false)).toBe("/home/a/x.png ");
	});

	it("escapes what a shell or Claude Code would split on, and quotes a Windows path", () => {
		expect(pathInput("/Users/a/ảnh chụp (2).png", false)).toBe("/Users/a/ảnh\\ chụp\\ \\(2\\).png ");
		expect(pathInput("C:\\Users\\a\\shot 1.png", false)).toBe('"C:\\Users\\a\\shot 1.png" ');
	});
});
