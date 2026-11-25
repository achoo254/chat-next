// The Live Map's event list as the approved design shows it: newest first,
// at most 80 rows with every event counted, a call with its status and
// runtime (running, ✓, failed), the model's thinking rows numbered by API
// turn, subagents, permissions, the stop of a turn and CI runs, each with its
// module; a call and a permission request open their detail, other rows pick
// their module; "Ẩn chi tiết" leaves out targets, labels and MCP tool names.
import { describe, expect, it } from "vitest";
import { FEED_MAX, feedRowsOf } from "../../../src/machines/observatory/event-feed.tsx";
import { OBSERVATORY_COPY } from "../../../src/machines/observatory/observatory-copy.ts";
import { played } from "../../observatory/render-fixtures.ts";
import { api, lifecycle, prompt, subagent, tool } from "./live-map-fixtures.ts";

const c = OBSERVATORY_COPY.vi;

describe("the event list", () => {
	it("lists the session newest first, each row with its module, status and runtime", () => {
		const { state } = played([
			prompt(1, 0),
			api("a1", 100, { contextTokens: 18_400 }),
			tool("r1", 200, { target: "src/app.ts" }),
			tool("r1", 580, { target: "src/app.ts", success: true, durationMs: 380 }),
			tool("b1", 600, { toolName: "Bash", target: "pnpm", station: "TESTING" }),
			tool("b1", 5_100, { toolName: "Bash", target: "pnpm", station: "TESTING", success: false, durationMs: 4_500 }),
			subagent("ag", 5_200),
			lifecycle("permission_request", "q1", 5_300, { label: "Bash pnpm install" }),
			lifecycle("permission_decision", "q2", 5_400, { label: "Bash pnpm install" }),
			lifecycle("ci_finished", "ci", 5_500, { label: "web", flag: true, number: 6_500 }),
			lifecycle("stop", "s1", 5_600),
			lifecycle("todo_counts", "t1", 5_700, { label: "1/2/3" }),
		]);
		const { rows, total } = feedRowsOf(c, state, false);
		expect(total).toBe(rows.length);
		expect(rows.map((r) => [r.place, r.text, r.status, r.durationMs, r.opens])).toEqual([
			["core", c.feed.stop, "", null, false],
			["git", c.feed.ciEnd("web", true), "ok", 6_500, false],
			["security", c.feed.permOk("Bash pnpm install"), "", null, false],
			["security", c.feed.permAsk("Bash pnpm install"), "", null, true],
			["orchestrator", c.feed.subStart("Explore"), "", null, false],
			["testing", "Bash pnpm", "err", 4_500, true],
			["files", "Read src/app.ts", "ok", 380, true],
			["core", c.feed.api(1, "18.400"), "", null, false],
			["user-desk", c.feed.prompt, "", null, false],
		]);
		expect(rows.find((r) => r.place === "core" && r.text.startsWith("suy nghĩ"))?.think).toBe(true);
	});

	it("marks a running call, and a subagent that ended with its runtime", () => {
		const { state } = played([prompt(1, 0), tool("r1", 10), subagent("ag", 20, Date.UTC(2026, 10, 23, 3, 0, 0) + 1_020)]);
		const { rows } = feedRowsOf(c, state, false);
		expect(rows.find((r) => r.eventId === "tool:r1")).toMatchObject({ status: "run", durationMs: null });
		expect(rows.find((r) => r.eventId === "subagent:ag")).toMatchObject({ text: c.feed.subEnd("Explore"), status: "ok", durationMs: 1_000 });
	});

	it("keeps the newest 80 rows and counts every event", () => {
		const events = [prompt(1, 0), ...Array.from({ length: 100 }, (_, i) => tool(`r${i}`, 10 + i * 10, { success: true, durationMs: 5 }))];
		const { rows, total } = feedRowsOf(c, played(events).state, false);
		expect(rows).toHaveLength(FEED_MAX);
		expect(total).toBe(101);
		expect(rows[0]?.eventId).toBe("tool:r99");
	});

	it("with Ẩn chi tiết leaves out targets, labels and MCP tool names", () => {
		const { state } = played([
			prompt(1, 0),
			tool("r1", 10, { target: "src/secret.ts" }),
			tool("m1", 20, { toolName: "mcp__acme-crm__lookup", mcpServer: "acme-crm", station: "MCP", target: "acme-crm › lookup" }),
			lifecycle("permission_request", "q1", 30, { label: "Bash rm -rf build" }),
			lifecycle("ci_finished", "ci", 40, { label: "deploy-web", flag: true }),
		]);
		const text = feedRowsOf(c, state, true)
			.rows.map((r) => r.text)
			.join("\n");
		expect(text).not.toMatch(/secret|acme|rm -rf|deploy-web/);
		expect(text).toContain(c.detail.kinds.tool);
		expect(text).toContain(c.feed.permAsk(""));
	});
});
