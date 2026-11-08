import { describe, expect, test } from "vitest";
import { hideSensitiveHeaders, redact, redactMessage } from "../../src/mcp/redact.ts";
import { withoutTuneloMcp } from "../../src/providers/claude/index.ts";

const JWT = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJhIn0.c2ln";

describe("redact", () => {
	test("hides tokens sent, JWTs (whole or cut) and Bearer values", () => {
		expect(redact(`a ${JWT} b`)).toBe("a [hidden] b");
		expect(redact("cut eyJhbGciOiJFUzI1NiJ9.eyJzdWIi")).toBe("cut [hidden]");
		expect(redact('"authorization":"Bearer opaque-123"')).toBe('"authorization":"Bearer [hidden]"');
		expect(redact("authorization: bearer opaque-123, next")).toBe("authorization: bearer [hidden], next");
		expect(redact("token tok_plain_9 here", ["tok_plain_9"])).toBe("token [hidden] here");
		expect(redact("nothing secret")).toBe("nothing secret");
	});

	test("cuts long messages", () => {
		expect(redactMessage("x".repeat(2000)).length).toBe(501);
	});

	test("hides the values of sensitive headers in JSON, keeps the rest", () => {
		const text = JSON.stringify({
			headers: [{ name: "X-Api-Key", value: "k1" }, { name: "Accept", value: "*/*" }],
			response: { headers: { Cookie: "c=1", "Set-Cookie": ["a=1"], "Content-Type": "text/html" } },
		});
		const out = hideSensitiveHeaders(text);
		expect(out).not.toContain("k1");
		expect(out).not.toContain("c=1");
		expect(out).not.toContain("a=1");
		expect(out).toContain("*/*");
		expect(out).toContain("text/html");
		expect(hideSensitiveHeaders("not json")).toBe("not json");
	});
});

describe("the machine's MCP servers in a session with tunelo's MCP", () => {
	test("drop any that runs `tunelo mcp` under another name", () => {
		const servers = {
			tun: { type: "stdio", command: "/usr/local/bin/tunelo", args: ["mcp"] },
			tunwin: { type: "stdio", command: "C:\\tools\\TUNELO.EXE", args: ["mcp"] },
			self: { type: "stdio", command: process.execPath, args: ["mcp"] },
			other: { type: "stdio", command: "npx", args: ["some-mcp"] },
			tunnelNoMcp: { type: "stdio", command: "tunelo", args: ["http", "3000"] },
		};
		expect(Object.keys(withoutTuneloMcp(servers)).sort()).toEqual(["other", "tunnelNoMcp"]);
	});
});
