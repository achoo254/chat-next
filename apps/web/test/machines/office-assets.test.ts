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
import { anchorsHash, ASSETS_FORMAT_VERSION, bakeHash, layoutHashes, loadOfficeAssets, parseOfficeAssets } from "../../src/machines/office/office-assets.ts";
import { projectPoint } from "../../src/machines/office/office-geometry.ts";
import { OFFICE_LAYOUT, OFFICE_LAYOUT_TEXT, type OfficeLayout } from "../../src/machines/office/office-layout.ts";

const FIXTURE = resolve(process.cwd(), "test/machines/fixtures/office-assets.json");
const SHIPPED = resolve(process.cwd(), "public/office/office-assets.json");
const PICTURE = { desktop: { width: 2400, height: 1500 }, phone: { width: 1600, height: 1600 } } as const;

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
		bakeSha256: await bakeHash(OFFICE_LAYOUT_TEXT),
		anchorsSha256: await anchorsHash(OFFICE_LAYOUT_TEXT),
		views: Object.fromEntries(
			(["desktop", "phone"] as const).map((size) => [
				size,
				{
					...PICTURE[size],
					day: `office-2d-plan-day-${size}.webp`,
					night: `office-2d-plan-night-${size}.webp`,
					anchors: Object.fromEntries(l.anchors.map((a) => [a.id, projectPoint(l.camera, l.camera.views[size], a.x, 0, a.z).map(round)])),
				},
			]),
		),
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

	it("reads the fixture: one picture of the plan per size, with every anchor of the layout", async () => {
		const result = parseOfficeAssets(fixture(), layout(), await layoutHashes());
		if (!result.ok) throw new Error(result.errors.join("\n"));
		const { desktop, phone } = result.value.views;
		expect(desktop.anchors.get("desk-0")).toHaveLength(2);
		expect(phone.day).toBe("office-2d-plan-day-phone.webp");
		expect(desktop).toMatchObject(PICTURE.desktop);
		for (const view of [desktop, phone]) expect([...view.anchors.keys()].sort()).toEqual(layout().anchors.map((a) => a.id).sort());
	});

	it("hashes the baked parts apart from the anchors: moving a seat needs no bake, moving furniture does", async () => {
		const base = JSON.parse(OFFICE_LAYOUT_TEXT) as { anchors: { x: number; seat?: number }[]; props: { x: number; anchor?: unknown }[] };
		const text = (l: unknown): string => JSON.stringify(l, null, "\t");
		const first = <T,>(list: T[]): T => {
			const item = list[0];
			if (item === undefined) throw new Error("the layout has none");
			return item;
		};
		expect(await bakeHash(text(base))).toMatch(/^[0-9a-f]{64}$/);
		const reformatted = JSON.stringify(base);
		expect(await bakeHash(reformatted)).toBe(await bakeHash(text(base)));
		const seatMoved = structuredClone(base);
		first(seatMoved.anchors).x += 0.3;
		first(seatMoved.anchors).seat = 0.4;
		first(seatMoved.props).anchor = "somewhere-else";
		expect(await bakeHash(text(seatMoved))).toBe(await bakeHash(text(base)));
		expect(await anchorsHash(text(seatMoved))).not.toBe(await anchorsHash(text(base)));
		const chairOnly = structuredClone(base);
		first(chairOnly.anchors).seat = 0.4;
		expect(await anchorsHash(text(chairOnly)), "a seat's height does not move its 2D dot").toBe(await anchorsHash(text(base)));
		const furnitureMoved = structuredClone(base);
		first(furnitureMoved.props).x += 0.3;
		expect(await bakeHash(text(furnitureMoved))).not.toBe(await bakeHash(text(base)));
	});

	it("keeps the pictures and projects the anchors itself when they moved since their 2D places were projected", async () => {
		const hashes = await layoutHashes();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const result = parseOfficeAssets({ ...fixture(), anchorsSha256: "0".repeat(64) }, layout(), hashes);
		if (!result.ok) throw new Error(result.errors.join("\n"));
		expect(result.value.views.desktop.day).toBe("office-2d-plan-day-desktop.webp");
		const fresh = parseOfficeAssets(fixture(), layout(), hashes);
		if (!fresh.ok) throw new Error(fresh.errors.join("\n"));
		// The same places as the file's: both come from the camera formula.
		expect([...result.value.views.desktop.anchors]).toEqual([...fresh.value.views.desktop.anchors]);
		expect([...result.value.views.phone.anchors]).toEqual([...fresh.value.views.phone.anchors]);
		expect(warn).toHaveBeenCalledOnce();
		warn.mockRestore();
	});

	it("refuses assets baked from another layout, with an anchor missing, or of another version", async () => {
		const hash = await layoutHashes();
		const stale = { ...fixture(), bakeSha256: "0".repeat(64) };
		expect(parseOfficeAssets(stale, layout(), hash)).toEqual({ ok: false, errors: ["the assets were baked from another layout (bakeSha256 differs): bake them again"] });
		const missing = fixture();
		const views = missing.views as { phone: { anchors: Record<string, unknown> } };
		delete views.phone.anchors["library-work-0"];
		const result = parseOfficeAssets(missing, layout(), hash);
		expect(result.ok ? [] : result.errors).toEqual(["phone view has no position for library-work-0"]);
		expect(parseOfficeAssets({ ...fixture(), formatVersion: 1 }, layout(), hash)).toEqual({ ok: false, errors: ["asset format version 1, this app reads 3"] });
		expect(parseOfficeAssets({ ...fixture(), formatVersion: 9 }, layout(), hash)).toEqual({ ok: false, errors: ["asset format version 9, this app reads 3"] });
		expect(parseOfficeAssets({ ...fixture(), views: {} }, layout(), hash)).toEqual({ ok: false, errors: ["desktop view is missing", "phone view is missing"] });
	});

	it("refuses picture names that leave the assets folder or start with a dot", async () => {
		const hash = await layoutHashes();
		for (const bad of ["..", ".hidden.webp", "../secret.webp", "a/b.webp", ""]) {
			const json = fixture();
			const views = json.views as { desktop: { day: string } };
			views.desktop.day = bad;
			const result = parseOfficeAssets(json, layout(), hash);
			expect(result.ok ? [] : result.errors, JSON.stringify(bad)).toEqual(["desktop view needs day and night file names"]);
		}
		expect(parseOfficeAssets(fixture(), layout(), hash).ok).toBe(true);
	});

	it("falls back when the file is missing or not JSON", async () => {
		const notFound = vi.fn(async () => new Response("", { status: 404 }));
		expect(await loadOfficeAssets(layout(), notFound)).toEqual({ ok: false, errors: ["office-assets.json: HTTP 404"] });
		const html = vi.fn(async () => new Response("<!doctype html>", { status: 200 }));
		const result = await loadOfficeAssets(layout(), html);
		expect(result.ok).toBe(false);
	});

	it.runIf(existsSync(SHIPPED))("matches the shipped asset file to the current layout", async () => {
		const shipped = JSON.parse(readFileSync(SHIPPED, "utf8")) as Record<string, unknown>;
		const result = parseOfficeAssets(shipped, layout(), await layoutHashes());
		expect(result.ok ? [] : result.errors).toEqual([]);
		expect(shipped.anchorsSha256, "the 2D places of the anchors are current (tools/office-art/project-anchors-2d.mjs)").toBe(await anchorsHash());
	});
});
