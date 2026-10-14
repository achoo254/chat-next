import { readFileSync } from "node:fs";

/** Reads a JSON file relative to the repository root. */
export function readRepoJson(relativePath: string): unknown {
	const url = new URL(`../../../${relativePath}`, import.meta.url);
	return JSON.parse(readFileSync(url, "utf8")) as unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export interface FoldVector {
	input: string;
	fold: string;
	tokens: string[];
}

/** Reads the shared vi-fold vectors (spec/vi-fold/test-vectors.json). */
export function loadFoldVectors(): FoldVector[] {
	const data = readRepoJson("spec/vi-fold/test-vectors.json");
	if (!Array.isArray(data)) {
		throw new TypeError("vi-fold vectors must be an array");
	}
	return data.map((item, index): FoldVector => {
		if (
			!isRecord(item) ||
			typeof item.input !== "string" ||
			typeof item.fold !== "string" ||
			!isStringArray(item.tokens)
		) {
			throw new TypeError(`malformed vi-fold vector #${index}`);
		}
		return { input: item.input, fold: item.fold, tokens: item.tokens };
	});
}
