// The macOS install script runs under /bin/sh (bash 3.2) with `set -u`. In a
// non-UTF-8 locale bash reads the first byte of a non-ASCII character right
// after `$NAME` as part of the name, so "$VERSION…" stops the script with
// "unbound variable". Every variable before non-ASCII text must use ${NAME}.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = readFileSync(resolve(process.cwd(), "public/agent/install.sh"), "latin1");

describe("install.sh", () => {
	it("braces every variable that is followed by a non-ASCII character", () => {
		const unsafe = script.split("\n").flatMap((line, i) => (/\$[A-Za-z_][A-Za-z0-9_]*[^\x20-\x7e\t]/.test(line) ? [`${i + 1}: ${line.trim()}`] : []));
		expect(unsafe).toEqual([]);
	});
});
