import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_NAME, isBinary, parsePatterns, run, scanText } from "./check-forbidden-patterns.ts";

const SECRET_TEXT = "corp-internal.test";

describe("parsePatterns", () => {
	it("one pattern per non-empty line, numbered in order, CRLF tolerated", () => {
		const ps = parsePatterns("alpha\\.test\r\n\n  beta  \n");
		expect(ps.map((p) => [p.index, p.literal])).toEqual([
			[1, false],
			[2, false],
		]);
		expect(ps[0]?.re.test("x.ALPHA.TEST.y")).toBe(true);
		expect(ps[1]?.re.test("beta")).toBe(true);
	});

	it("an invalid expression is matched as plain text", () => {
		const [p] = parsePatterns("acme(");
		expect(p?.literal).toBe(true);
		expect(p?.re.test("see acme( here")).toBe(true);
		expect(p?.re.test("acme")).toBe(false);
	});
});

describe("scanText", () => {
	it("reports file, 1-based line and pattern number for every match", () => {
		const ps = parsePatterns("first-word\nsecond-word");
		expect(scanText("a.ts", "ok\nfirst-word and second-word\nnope\nSECOND-WORD", ps)).toEqual([
			{ path: "a.ts", line: 2, pattern: 1 },
			{ path: "a.ts", line: 2, pattern: 2 },
			{ path: "a.ts", line: 4, pattern: 2 },
		]);
	});
});

describe("isBinary", () => {
	it("a NUL byte marks a binary file", () => {
		expect(isBinary(Buffer.from([0x89, 0x50, 0x00, 0x47]))).toBe(true);
		expect(isBinary(Buffer.from("plain text"))).toBe(false);
	});
});

describe("run", () => {
	let dir = "";
	afterEach(() => {
		if (dir !== "") rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	function repo(files: Record<string, string>, untracked: Record<string, string> = {}): string {
		dir = mkdtempSync(join(tmpdir(), "forbidden-patterns-"));
		execFileSync("git", ["init", "-q"], { cwd: dir });
		for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
		execFileSync("git", ["add", "."], { cwd: dir });
		for (const [name, text] of Object.entries(untracked)) writeFileSync(join(dir, name), text);
		return dir;
	}

	it("is a no-op with a notice when the variable is absent or empty", () => {
		const root = repo({ "a.md": SECRET_TEXT });
		for (const env of [{}, { [ENV_NAME]: "" }, { [ENV_NAME]: " \n " }]) {
			const r = run(env, root);
			expect(r.code).toBe(0);
			expect(r.output.join("\n")).toMatch(/not set; skipped/);
		}
	});

	it("fails on a tracked match and prints neither the pattern nor the matched text", () => {
		const root = repo({ "doc.md": "line one\nhost corp-internal.test here\n", "clean.ts": "export {};\n" });
		const r = run({ [ENV_NAME]: "unused-word\ncorp-internal\\.test" }, root);
		expect(r.code).toBe(1);
		expect(r.output).toContain("doc.md:2: forbidden pattern #2");
		const all = r.output.join("\n");
		expect(all).not.toContain("corp-internal");
		expect(all).not.toContain("unused-word");
		expect(all).not.toContain("clean.ts");
	});

	it("ignores untracked and binary files", () => {
		const root = repo({ "bin.dat": `\0${SECRET_TEXT}` }, { "scratch.md": SECRET_TEXT });
		const r = run({ [ENV_NAME]: "corp-internal" }, root);
		expect(r.code).toBe(0);
		expect(r.output.at(-1)).toMatch(/1 pattern\(s\), no match/);
	});
});
