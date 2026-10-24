import { describe, expect, it } from "vitest";
import { KNOWN_TLDS } from "../src/entities/known-tlds.ts";
import { detectEntities, type ExistingEntity } from "../src/index.ts";
import { isRecord, isStringArray, readRepoJson } from "./load-json.ts";

interface FoundVector {
	type: string;
	offset: number;
	length: number;
	text: string;
}

interface DetectCase {
	name: string;
	text: string;
	entities: ExistingEntity[];
	limit: number;
	found: FoundVector[];
}

function isSpanRecord(value: unknown): value is Record<string, unknown> & { type: string; offset: number; length: number } {
	return isRecord(value) && typeof value.type === "string" && typeof value.offset === "number" && typeof value.length === "number";
}

/** Reads spec/entities/detect-vectors.json, shared with the Go suite. */
function loadVectors(): { tlds: string[]; cases: DetectCase[] } {
	const data = readRepoJson("spec/entities/detect-vectors.json");
	if (!isRecord(data) || !isStringArray(data.tlds) || !Array.isArray(data.cases)) {
		throw new TypeError("malformed detect vectors");
	}
	const cases = data.cases.map((item: unknown, index): DetectCase => {
		if (!isRecord(item) || typeof item.name !== "string" || typeof item.text !== "string" || !Array.isArray(item.found)) {
			throw new TypeError(`malformed detect vector #${index}`);
		}
		const entities = Array.isArray(item.entities) ? item.entities : [];
		return {
			name: item.name,
			text: item.text,
			entities: entities.map((entity: unknown) => {
				if (!isSpanRecord(entity)) throw new TypeError(`malformed entity in detect vector #${index}`);
				return { type: entity.type, offset: entity.offset, length: entity.length };
			}),
			limit: typeof item.limit === "number" ? item.limit : 100,
			found: item.found.map((found: unknown) => {
				if (!isSpanRecord(found) || typeof found.text !== "string") throw new TypeError(`malformed found in detect vector #${index}`);
				return { type: found.type, offset: found.offset, length: found.length, text: found.text };
			}),
		};
	});
	return { tlds: data.tlds, cases };
}

const vectors = loadVectors();

describe("detectEntities (spec/entities/detect-vectors.json)", () => {
	it.each(vectors.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
		const found = detectEntities(c.text, c.entities, "com.hoandat.chat", c.limit);
		expect(found).toEqual(c.found.map(({ type, offset, length }) => ({ type, offset, length })));
		for (const want of c.found) expect(c.text.slice(want.offset, want.offset + want.length)).toBe(want.text);
	});

	it("knows the same TLDs as the vectors (and the Go twin)", () => {
		expect([...KNOWN_TLDS].sort()).toEqual(vectors.tlds);
	});

	it("returns nothing for empty text or a zero limit", () => {
		expect(detectEntities("", [], "", 10)).toEqual([]);
		expect(detectEntities("#a #b", [], "", 0)).toEqual([]);
	});
});
