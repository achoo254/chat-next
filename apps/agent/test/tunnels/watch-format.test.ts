import { describe, expect, test } from "vitest";
import type { InspectorEntry } from "./request-store.js";
import type { RunRecord } from "./run-registry.js";
import { matchRuns, targetSubdomain } from "./run-target.js";
import {
	formatDetails,
	formatLine,
	isStatusFilter,
	matchesFilter,
} from "./watch-format.js";

const entry: InspectorEntry = {
	id: "r1",
	timestamp: Date.UTC(2026, 9, 13, 9, 1, 3),
	subdomain: "api",
	method: "POST",
	path: "/v1/orders?id=7",
	requestHeaders: { "content-type": "application/json" },
	requestBody: '{"qty":1}',
	status: 502,
	responseHeaders: { "x-a": ["1", "2"] },
	responseBody: "bad gateway",
	durationMs: 12.4,
	entryType: "normal",
};

const plain = (text: string): string =>
	text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");

describe("watch filters", () => {
	test("status classes and codes", () => {
		expect(isStatusFilter("5xx")).toBe(true);
		expect(isStatusFilter("40x")).toBe(true);
		expect(isStatusFilter("404")).toBe(true);
		expect(isStatusFilter("ok")).toBe(false);
		expect(isStatusFilter("6xx")).toBe(false);
		expect(matchesFilter(entry, { status: "5xx" })).toBe(true);
		expect(matchesFilter(entry, { status: "4xx" })).toBe(false);
		expect(matchesFilter(entry, { status: "502" })).toBe(true);
	});

	test("path text and subdomain", () => {
		expect(matchesFilter(entry, { path: "ORDERS" })).toBe(true);
		expect(matchesFilter(entry, { path: "users" })).toBe(false);
		expect(matchesFilter(entry, { subdomain: "api" })).toBe(true);
		expect(matchesFilter(entry, { subdomain: "web" })).toBe(false);
	});
});

describe("watch output", () => {
	test("one line per request, the subdomain only when asked", () => {
		const line = plain(formatLine(entry, false));
		expect(line).toMatch(/POST\s+502\s+12ms {2}\/v1\/orders\?id=7$/);
		expect(plain(formatLine(entry, true))).toMatch(/ {2}api$/);
	});

	test("headers and bodies, sent then received", () => {
		const lines = formatDetails(entry, { headers: true, body: true }).map(
			plain,
		);
		expect(lines).toEqual([
			"    > content-type: application/json",
			'    > {"qty":1}',
			"    < x-a: 1, 2",
			"    < bad gateway",
		]);
		expect(formatDetails(entry, { headers: false, body: false })).toEqual([]);
	});
});

describe("watch target", () => {
	const record: RunRecord = {
		pid: 4242,
		kind: "http",
		startedAt: 0,
		server: "https://tunnel.example.test",
		tunnels: [
			{ url: "https://api.tunnel.example.test", localPort: 3000 },
			{ url: "https://web.tunnel.example.test", localPort: 4000 },
		],
	};

	test("a PID, a subdomain or a URL names the process", () => {
		expect(matchRuns([record], "4242")).toEqual([record]);
		expect(matchRuns([record], "web")).toEqual([record]);
		expect(matchRuns([record], "nope")).toEqual([]);
	});

	test("a subdomain or URL narrows to that tunnel, a PID does not", () => {
		expect(targetSubdomain(record, "web")).toBe("web");
		expect(targetSubdomain(record, "https://api.tunnel.example.test")).toBe(
			"api",
		);
		expect(targetSubdomain(record, "4242")).toBeUndefined();
	});
});
