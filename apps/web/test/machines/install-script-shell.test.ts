// The macOS install script runs under /bin/sh (bash 3.2) with `set -u`. In a
// non-UTF-8 locale bash reads the first byte of a non-ASCII character right
// after `$NAME` as part of the name, so "$VERSION…" stops the script with
// "unbound variable". Every variable before non-ASCII text must use ${NAME}.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = readFileSync(resolve(process.cwd(), "public/agent/install.sh"), "latin1");
const utf8Script = readFileSync(resolve(process.cwd(), "public/agent/install.sh"), "utf8");

/** The text of a top-level function of the script. */
function fn(name: string): string {
	const found = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, "m").exec(utf8Script);
	if (found === null) throw new Error(`install.sh has no ${name}()`);
	return found[0];
}

/** Runs pick_asset with the script's own pins (and optional overrides), under POSIX sh. */
function pickAsset(os: string, machine: string, pins = ""): { status: number | null; out: string; err: string } {
	const pinLines = utf8Script.split("\n").filter((l) => /^(TUNELO_VERSION|SHA256_[A-Z0-9_]+)=/.test(l));
	const code = [...pinLines, pins, "lang=en", fn("say"), fn("die"), fn("pick_asset"), 'pick_asset "$1" "$2"', 'printf "%s %s" "$asset" "$sha"'].join("\n");
	const r = spawnSync("sh", ["-c", code, "sh", os, machine], { encoding: "utf8" });
	return { status: r.status, out: r.stdout, err: r.stderr };
}

describe("install.sh", () => {
	it("braces every variable that is followed by a non-ASCII character", () => {
		const unsafe = script.split("\n").flatMap((line, i) => (/\$[A-Za-z_][A-Za-z0-9_]*[^\x20-\x7e\t]/.test(line) ? [`${i + 1}: ${line.trim()}`] : []));
		expect(unsafe).toEqual([]);
	});
});

describe("install.sh picks the build for the system", () => {
	const pins = 'SHA256_LINUX_X64="lx" SHA256_LINUX_ARM64="la"';

	it("Linux x86_64 and aarch64, as uname names them", () => {
		expect(pickAsset("Linux", "x86_64", pins).out).toBe("tunelo-linux-x64 lx");
		expect(pickAsset("Linux", "amd64", pins).out).toBe("tunelo-linux-x64 lx");
		expect(pickAsset("Linux", "aarch64", pins).out).toBe("tunelo-linux-arm64 la");
		expect(pickAsset("Linux", "arm64", pins).out).toBe("tunelo-linux-arm64 la");
	});

	it("macOS as before", () => {
		expect(pickAsset("Darwin", "arm64").out).toMatch(/^tunelo-darwin-arm64 [0-9a-f]{64}$/);
		expect(pickAsset("Darwin", "x86_64").out).toMatch(/^tunelo-darwin-x64 [0-9a-f]{64}$/);
	});

	it("names the systems and processors there are builds for", () => {
		const cpu = pickAsset("Linux", "riscv64", pins);
		expect(cpu.status).toBe(1);
		expect(cpu.err).toContain("no build for the riscv64 processor (there are: macOS arm64, x86_64; Linux x86_64, aarch64)");
		const os = pickAsset("FreeBSD", "amd64", pins);
		expect(os.status).toBe(1);
		expect(os.err).toContain("available for macOS, Linux and Windows; this machine runs FreeBSD");
	});

	it("a release pinned without Linux builds refuses Linux instead of downloading nothing", () => {
		const r = pickAsset("Linux", "x86_64", 'SHA256_LINUX_X64=""');
		expect(r.status).toBe(1);
		expect(r.err).toMatch(/has no Linux build yet/);
	});
});
