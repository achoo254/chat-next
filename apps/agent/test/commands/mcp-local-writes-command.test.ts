// `tunelo config mcp-local-writes`: writes go on only for a person at a
// terminal who types yes; off and the state always work.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { NEEDS_TERMINAL, runLocalWrites, type Terminal } from "../../src/commands/mcp-local-writes.ts";
import { LocalWritesSetting } from "../../src/mcp/local-writes.ts";

function terminal(interactive: boolean, answer: string | Error = "yes"): Terminal & { out: string[]; err: string[]; asked: number } {
	const t = {
		interactive,
		out: [] as string[],
		err: [] as string[],
		asked: 0,
		ask: async () => {
			t.asked++;
			if (answer instanceof Error) throw answer;
			return answer;
		},
		print: (line: string) => void t.out.push(line),
		printError: (line: string) => void t.err.push(line),
	};
	return t;
}

describe("tunelo config mcp-local-writes", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "tunelo-local-writes-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const enabled = () => new LocalWritesSetting(dir).enabled();
	const audit = () => {
		try {
			return readFileSync(join(dir, "audit.jsonl"), "utf8");
		} catch {
			return "";
		}
	};

	test("on without a terminal is refused before asking, and nothing changes", async () => {
		const t = terminal(false);
		expect(await runLocalWrites("on", dir, t)).toBe(1);
		expect(t.asked).toBe(0);
		expect(t.err).toEqual([NEEDS_TERMINAL]);
		expect(enabled()).toBe(false);
		expect(audit()).toBe("");
	});

	test("on at a terminal turns writes on only after yes, and logs the consent", async () => {
		const t = terminal(true, " YES \n");
		expect(await runLocalWrites("on", dir, t)).toBe(0);
		expect(t.asked).toBe(1);
		expect(enabled()).toBe(true);
		expect(t.out.join("\n")).toContain("MCP writes outside tunelo's AI sessions: on.");
		expect(audit()).toMatch(/"action":"mcp_local_writes".*"detail":"on"/);
	});

	test.each(["", "y", "no", "on"])("any other answer (%j) keeps writes off", async (answer) => {
		const t = terminal(true, answer);
		expect(await runLocalWrites("on", dir, t)).toBe(1);
		expect(enabled()).toBe(false);
		expect(t.out).toContain("Nothing changed: writes stay off.");
		expect(audit()).toBe("");
	});

	test("a closed stdin while asking keeps writes off", async () => {
		const t = terminal(true, new Error("closed"));
		expect(await runLocalWrites("on", dir, t)).toBe(1);
		expect(enabled()).toBe(false);
	});

	test("off always works, with or without a terminal", async () => {
		await new LocalWritesSetting(dir).set(true);
		const t = terminal(false);
		expect(await runLocalWrites("off", dir, t)).toBe(0);
		expect(enabled()).toBe(false);
		expect(t.err).toEqual([]);
		expect(audit()).toMatch(/"detail":"off"/);
	});

	test("the state reads without a terminal; on when already on asks nothing", async () => {
		const t = terminal(false);
		expect(await runLocalWrites(undefined, dir, t)).toBe(0);
		expect(t.out.join("\n")).toContain(": off (default)");
		await new LocalWritesSetting(dir).set(true);
		const again = terminal(false);
		expect(await runLocalWrites("on", dir, again)).toBe(0);
		expect(again.asked).toBe(0);
		expect(enabled()).toBe(true);
	});

	test("an unknown action is an error", async () => {
		await expect(runLocalWrites("maybe", dir, terminal(true))).rejects.toThrow(/unknown action/);
	});
});
