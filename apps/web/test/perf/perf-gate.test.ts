import { describe, expect, it } from "vitest";
import { parseManifest, startupFiles, type Manifest } from "./bundle.ts";
import { frameStats, longTaskStats, percentile } from "./stats.ts";

describe("percentile", () => {
	it("uses the nearest rank", () => {
		const values = [5, 1, 4, 2, 3];
		expect(percentile(values, 50)).toBe(3);
		expect(percentile(values, 99)).toBe(5);
		expect(percentile(values, 0)).toBe(1);
	});

	it("is NaN without samples", () => {
		expect(percentile([], 50)).toBeNaN();
	});
});

describe("frameStats", () => {
	it("counts frames over two vsyncs as slow, not a single missed vsync", () => {
		// 16.7 ms frames, one 33.3 ms gap (one missed vsync), one 50 ms gap.
		const stats = frameStats([0, 16.7, 33.4, 66.7, 116.7, 133.4]);
		expect(stats.frames).toBe(5);
		expect(stats.slowFrames).toBe(1);
		expect(stats.maxFrameMs).toBeCloseTo(50);
		expect(stats.averageFps).toBeCloseTo((5 * 1000) / 133.4);
	});

	it("reports nothing for fewer than two frames", () => {
		expect(frameStats([10])).toEqual({ frames: 0, maxFrameMs: 0, slowFrames: 0, averageFps: 0 });
	});
});

describe("longTaskStats", () => {
	it("sums the blocking part beyond 50 ms", () => {
		expect(longTaskStats([60, 120, 51])).toEqual({ count: 3, totalBlockingMs: 81, longestMs: 120 });
		expect(longTaskStats([])).toEqual({ count: 0, totalBlockingMs: 0, longestMs: 0 });
	});
});

const manifest: Manifest = {
	"index.html": { file: "assets/index.js", isEntry: true, imports: ["_shared.js"], dynamicImports: ["src/root.tsx", "src/lazy.tsx"], css: ["assets/index.css"] },
	"_shared.js": { file: "assets/shared.js" },
	"src/root.tsx": { file: "assets/root.js", imports: ["_shared.js", "_row.js"], dynamicImports: ["src/lazy.tsx"], css: ["assets/root.css"] },
	"_row.js": { file: "assets/row.js" },
	"src/lazy.tsx": { file: "assets/lazy.js", imports: ["_big.js"] },
	"_big.js": { file: "assets/big.js" },
	"sqlite3.wasm": { file: "assets/sqlite3.wasm" },
};

describe("startupFiles", () => {
	it("follows static imports of the entry and the startup modules only", () => {
		expect(startupFiles(manifest, ["src/root.tsx"])).toEqual({
			js: ["assets/index.js", "assets/root.js", "assets/row.js", "assets/shared.js"],
			css: ["assets/index.css", "assets/root.css"],
		});
	});

	it("fails when a startup module is not a chunk", () => {
		expect(() => startupFiles(manifest, ["src/renamed.tsx"])).toThrow(/src\/renamed\.tsx/);
	});
});

describe("parseManifest", () => {
	it("accepts a manifest and rejects other shapes", () => {
		expect(parseManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
		expect(() => parseManifest([])).toThrow(/not an object/);
		expect(() => parseManifest(null)).toThrow(/not an object/);
		expect(() => parseManifest({ "a.js": { file: 1 } })).toThrow(/a\.js/);
		expect(() => parseManifest({ "a.js": { file: "a.js", imports: [2] } })).toThrow(/a\.js/);
	});
});
