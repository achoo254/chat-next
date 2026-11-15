// The 2D pictures' asset file: the sample fixture matches the current layout
// (hash and every anchor), a stale hash, a missing anchor or another format
// version say so, and the shipped public/office/office-assets.json (once the
// assets are baked) passes the same check, so changing the layout without
// baking again fails here.
//
// The fixture is made from the layout with the default camera. After a layout
// change, write it again with:
//   UPDATE_OFFICE_FIXTURE=1 pnpm --filter @app/web exec vitest run test/machines/office-assets.test.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ASSETS_FORMAT_VERSION, layoutHash, loadOfficeAssets, parseOfficeAssets } from "../../src/machines/office/office-assets.ts";
import { projectPoint } from "../../src/machines/office/office-geometry.ts";
import { OFFICE_LAYOUT, OFFICE_LAYOUT_TEXT, type OfficeLayout } from "../../src/machines/office/office-layout.ts";

const FIXTURE = resolve(process.cwd(), "test/machines/fixtures/office-assets.json");
const SHIPPED = resolve(process.cwd(), "public/office/office-assets.json");
const PICTURE = { desktop: { width: 1600, height: 1000 }, phone: { width: 1200, height: 1200 } } as const;

function layout(): OfficeLayout {
	if (!OFFICE_LAYOUT.ok) throw new Error(OFFICE_LAYOUT.errors.join("\n"));
	return OFFICE_LAYOUT.value;
}

const round = (n: number): number => Math.round(n * 100) / 100;

/** The sample asset file for the current layout, as the bake of the 3D assets writes it. */
async function expectedFixture(): Promise<Record<string, unknown>> {
	const l = layout();
	return {
		formatVersion: ASSETS_FORMAT_VERSION,
		layoutSha256: await layoutHash(OFFICE_LAYOUT_TEXT),
		floors: l.floors.map((floor) => ({
			level: floor.level,
			views: Object.fromEntries(
				(["desktop", "phone"] as const).map((size) => [
					size,
					{
						...PICTURE[size],
						day: `office-2d-floor-${floor.level}-day-${size}.webp`,
						night: `office-2d-floor-${floor.level}-night-${size}.webp`,
						anchors: Object.fromEntries(floor.anchors.map((a) => [a.id, projectPoint(l.camera, l.camera.views[size], a.x, 0, a.z).map(round)])),
					},
				]),
			),
		})),
	};
}

function fixture(): Record<string, unknown> {
	return JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;
}

describe("the office's asset file", () => {
	it("has a sample fixture made from the current layout", async () => {
		const expected = await expectedFixture();
		if (process.env.UPDATE_OFFICE_FIXTURE === "1") writeFileSync(FIXTURE, `${JSON.stringify(expected, null, "\t")}\n`);
		expect(fixture(), "the layout changed: write the fixture again (see the top of this file)").toEqual(expected);
	});

	it("reads the fixture: every anchor of every floor, both sizes", async () => {
		const result = parseOfficeAssets(fixture(), layout(), await layoutHash());
		if (!result.ok) throw new Error(result.errors.join("\n"));
		const first = result.value.floors.get(1);
		expect(first?.desktop.anchors.get("desk-0")).toHaveLength(2);
		expect(first?.phone.day).toBe("office-2d-floor-1-day-phone.webp");
		expect(result.value.floors.size).toBe(3);
	});

	it("hashes the layout's text the same with either line ending", async () => {
		const lf = await layoutHash("{\n}\n");
		expect(await layoutHash("{\r\n}\r\n")).toBe(lf);
		expect(lf).toMatch(/^[0-9a-f]{64}$/);
	});

	it("refuses assets baked from another layout, with an anchor missing, or of another version", async () => {
		const hash = await layoutHash();
		const stale = { ...fixture(), layoutSha256: "0".repeat(64) };
		expect(parseOfficeAssets(stale, layout(), hash)).toEqual({ ok: false, errors: ["the assets were baked from another layout (layoutSha256 differs): bake them again"] });
		const missing = fixture();
		const floors = missing.floors as { views: { phone: { anchors: Record<string, unknown> } } }[];
		const phone = floors[1]?.views.phone;
		if (phone !== undefined) delete phone.anchors["library-work-0"];
		const result = parseOfficeAssets(missing, layout(), hash);
		expect(result.ok ? [] : result.errors).toEqual(["floor 2 phone has no position for library-work-0"]);
		expect(parseOfficeAssets({ ...fixture(), formatVersion: 9 }, layout(), hash)).toEqual({ ok: false, errors: ["asset format version 9, this app reads 1"] });
		expect(parseOfficeAssets({ ...fixture(), floors: [] }, layout(), hash).ok).toBe(false);
	});

	it("falls back when the file is missing or not JSON", async () => {
		const notFound = vi.fn(async () => new Response("", { status: 404 }));
		expect(await loadOfficeAssets(layout(), notFound)).toEqual({ ok: false, errors: ["office-assets.json: HTTP 404"] });
		const html = vi.fn(async () => new Response("<!doctype html>", { status: 200 }));
		const result = await loadOfficeAssets(layout(), html);
		expect(result.ok).toBe(false);
	});

	it.runIf(existsSync(SHIPPED))("matches the shipped asset file to the current layout", async () => {
		const result = parseOfficeAssets(JSON.parse(readFileSync(SHIPPED, "utf8")), layout(), await layoutHash());
		expect(result.ok ? [] : result.errors).toEqual([]);
	});
});
