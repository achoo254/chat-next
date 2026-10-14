import { describe, expect, it } from "vitest";
import {
	type EntityError,
	type EntityErrorCode,
	type EntitySpan,
	codePointLength,
	isAllowedUrl,
	isAllowedWebUrl,
	normalizeLinkUrl,
	utf16Length,
	validateEntities,
} from "../src/index.ts";
import { isRecord, readRepoJson } from "./load-json.ts";

interface LengthVector {
	name: string;
	text: string;
	utf16: number;
	codePoints: number;
}

interface EntityVector {
	name: string;
	text: string;
	entities: EntitySpan[];
	errors: EntityError[];
}

interface UrlVector {
	url: string;
	appScheme: string;
	allowed: boolean;
}

interface LinkTextVector {
	text: string;
	appScheme: string;
	/** The URL the text opens, or null when it is rejected. */
	url: string | null;
}

interface WebUrlVector {
	url: string;
	allowed: boolean;
}

interface Vectors {
	lengths: LengthVector[];
	entities: EntityVector[];
	urls: UrlVector[];
	linkTexts: LinkTextVector[];
	webUrls: WebUrlVector[];
}

const ERROR_CODES: readonly string[] = [
	"invalid_offset",
	"invalid_length",
	"out_of_bounds",
	"splits_surrogate_pair",
	"partial_overlap",
] satisfies EntityErrorCode[];

function isErrorCode(value: string): value is EntityErrorCode {
	return ERROR_CODES.includes(value);
}

function fail(section: string, index: number): never {
	throw new TypeError(`malformed ${section} vector #${index}`);
}

function arrayField(data: Record<string, unknown>, key: string): unknown[] {
	const value = data[key];
	if (!Array.isArray(value)) {
		throw new TypeError(`entities vectors: "${key}" must be an array`);
	}
	return value;
}

function parseSpan(value: unknown, index: number): EntitySpan {
	if (!isRecord(value) || typeof value.offset !== "number" || typeof value.length !== "number") {
		return fail("entities", index);
	}
	return { offset: value.offset, length: value.length };
}

function parseError(value: unknown, index: number): EntityError {
	if (!isRecord(value) || typeof value.index !== "number" || typeof value.code !== "string") {
		return fail("entities", index);
	}
	const code = value.code;
	if (!isErrorCode(code)) {
		return fail("entities", index);
	}
	return { index: value.index, code };
}

function loadVectors(): Vectors {
	const data = readRepoJson("spec/entities/test-vectors.json");
	if (!isRecord(data)) {
		throw new TypeError("entities vectors must be an object");
	}
	const lengths = arrayField(data, "lengths").map((v, i): LengthVector => {
		if (
			!isRecord(v) ||
			typeof v.name !== "string" ||
			typeof v.text !== "string" ||
			typeof v.utf16 !== "number" ||
			typeof v.codePoints !== "number"
		) {
			return fail("lengths", i);
		}
		return { name: v.name, text: v.text, utf16: v.utf16, codePoints: v.codePoints };
	});
	const entities = arrayField(data, "entities").map((v, i): EntityVector => {
		if (
			!isRecord(v) ||
			typeof v.name !== "string" ||
			typeof v.text !== "string" ||
			!Array.isArray(v.entities) ||
			!Array.isArray(v.errors)
		) {
			return fail("entities", i);
		}
		return {
			name: v.name,
			text: v.text,
			entities: v.entities.map((span: unknown) => parseSpan(span, i)),
			errors: v.errors.map((error: unknown) => parseError(error, i)),
		};
	});
	const urls = arrayField(data, "urls").map((v, i): UrlVector => {
		if (!isRecord(v) || typeof v.url !== "string" || typeof v.appScheme !== "string" || typeof v.allowed !== "boolean") {
			return fail("urls", i);
		}
		return { url: v.url, appScheme: v.appScheme, allowed: v.allowed };
	});
	const linkTexts = arrayField(data, "linkTexts").map((v, i): LinkTextVector => {
		if (
			!isRecord(v) ||
			typeof v.text !== "string" ||
			typeof v.appScheme !== "string" ||
			(typeof v.url !== "string" && v.url !== null)
		) {
			return fail("linkTexts", i);
		}
		return { text: v.text, appScheme: v.appScheme, url: v.url };
	});
	const webUrls = arrayField(data, "webUrls").map((v, i): WebUrlVector => {
		if (!isRecord(v) || typeof v.url !== "string" || typeof v.allowed !== "boolean") {
			return fail("webUrls", i);
		}
		return { url: v.url, allowed: v.allowed };
	});
	return { lengths, entities, urls, linkTexts, webUrls };
}

const vectors = loadVectors();

describe("entities shared vectors", () => {
	it("has at least 40 vectors", () => {
		expect(vectors.lengths.length + vectors.entities.length + vectors.urls.length).toBeGreaterThanOrEqual(40);
	});

	it.each(vectors.lengths.map((v) => [v.name, v] as const))("length: %s", (_name, v) => {
		expect(utf16Length(v.text)).toBe(v.utf16);
		expect(codePointLength(v.text)).toBe(v.codePoints);
	});

	it.each(vectors.entities.map((v) => [v.name, v] as const))("entities: %s", (_name, v) => {
		expect(validateEntities(v.text, v.entities)).toEqual(v.errors);
	});

	it.each(vectors.urls.map((v) => [JSON.stringify(v.url), v] as const))("url: %s", (_name, v) => {
		expect(isAllowedUrl(v.url, v.appScheme)).toBe(v.allowed);
	});

	it.each(vectors.linkTexts.map((v) => [JSON.stringify(v.text), v] as const))("link text: %s", (_name, v) => {
		expect(normalizeLinkUrl(v.text, v.appScheme) ?? null).toBe(v.url);
	});

	it.each(vectors.webUrls.map((v) => [JSON.stringify(v.url), v] as const))("web url: %s", (_name, v) => {
		expect(isAllowedWebUrl(v.url)).toBe(v.allowed);
	});
});

describe("TypeScript-only inputs", () => {
	it("rejects non-finite and unsafe numbers", () => {
		expect(validateEntities("abc", [{ offset: Number.NaN, length: 1 }])).toEqual([
			{ index: 0, code: "invalid_offset" },
		]);
		expect(validateEntities("abc", [{ offset: 0, length: Number.POSITIVE_INFINITY }])).toEqual([
			{ index: 0, code: "invalid_length" },
		]);
	});

	it("does not treat a lone surrogate as a pair", () => {
		const text = "a\uD83Db";
		expect(utf16Length(text)).toBe(3);
		expect(codePointLength(text)).toBe(3);
		expect(validateEntities(text, [{ offset: 2, length: 1 }])).toEqual([]);
	});

	it("rejects URLs containing lone surrogates", () => {
		expect(isAllowedUrl("https://example.com/\uD83D", "app")).toBe(false);
		expect(isAllowedWebUrl("https://example.com/\uD83D")).toBe(false);
		expect(normalizeLinkUrl("example.com/\uD83D", "app")).toBeUndefined();
	});

	it("handles many nested entities in O(n log n)", () => {
		const n = 100_000;
		const text = "a".repeat(2 * n);
		const spans = Array.from({ length: n }, (_, i) => ({ offset: i, length: 2 * n - 2 * i }));
		expect(validateEntities(text, spans)).toEqual([]);
	});
});
