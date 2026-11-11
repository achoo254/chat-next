// The repository key of a git remote, checked against the vectors the Go
// server checks too (spec/git-remote/test-vectors.json), so a device and the
// server always agree on which repository a folder belongs to; and the
// attach rule built on it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalRemote, remoteMismatch, remoteUrlFor, repoName } from "../../src/machines/git-remote.ts";

interface Vector {
	input: string;
	key: string | null;
	note: string;
}

const vectors = JSON.parse(readFileSync(resolve(process.cwd(), "../../spec/git-remote/test-vectors.json"), "utf8")) as Vector[];

describe("canonicalRemote", () => {
	it("has the shared vectors to check", () => {
		expect(vectors.length).toBeGreaterThanOrEqual(30);
	});

	it.each(vectors.map((v) => [v.note, v] as const))("%s", (_note, v) => {
		expect(canonicalRemote(v.input)).toBe(v.key);
	});

	it("gives one key to every form of one repository", () => {
		const forms = ["git@github.com:Achoo254/Chat-Next.git", "https://github.com/achoo254/chat-next", "ssh://git@github.com:22/achoo254/chat-next.git/", "https://x:secret@GITHUB.com/achoo254/chat-next.git"];
		expect(new Set(forms.map(canonicalRemote))).toEqual(new Set(["github.com/achoo254/chat-next"]));
	});

	it("refuses what is too long", () => {
		expect(canonicalRemote(`https://github.com/${"a".repeat(2048)}`)).toBeNull();
		expect(canonicalRemote(`https://github.com/${"a".repeat(512)}`)).toBeNull();
	});
});

describe("what the server gets and the attach rule", () => {
	it("sends a URL the server reads back as the same key, never the user or token typed", () => {
		const key = canonicalRemote("https://user:token@github.com/a/app.git") ?? "";
		expect(remoteUrlFor(key, "https://user:token@github.com/a/app.git")).toBe("https://github.com/a/app");
		expect(canonicalRemote(remoteUrlFor(key, ""))).toBe(key);
		expect(repoName(key)).toBe("app");
	});

	it("refuses a folder of another repository, takes the same one in any form, a folder outside git or a project linking none", () => {
		expect(remoteMismatch("github.com/a/app", "git@github.com:a/other.git")).toBe(true);
		expect(remoteMismatch("github.com/a/app", "git@github.com:A/App.git")).toBe(false);
		expect(remoteMismatch("github.com/a/app", "")).toBe(false);
		expect(remoteMismatch("", "git@github.com:a/other.git")).toBe(false);
	});
});
