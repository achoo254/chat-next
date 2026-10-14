import { describe, expect, it } from "vitest";
import { fold, searchText, tokens } from "../src/index.ts";
import { loadFoldVectors } from "./load-json.ts";

const vectors = loadFoldVectors();

describe("vifold shared vectors", () => {
	it("has at least 300 vectors", () => {
		expect(vectors.length).toBeGreaterThanOrEqual(300);
	});

	it.each(vectors.map((v, i) => [i, v] as const))("vector #%i", (_index, vector) => {
		expect(fold(vector.input)).toBe(vector.fold);
		expect(tokens(vector.input)).toEqual(vector.tokens);
		expect(searchText(vector.input)).toBe(vector.tokens.join(" "));
	});
});

describe("fold", () => {
	it("folds the required examples", () => {
		expect(fold("Người đẹp Đà Nẵng")).toBe("nguoi dep da nang");
		expect(fold("Ưu đãi")).toBe("uu dai");
		expect(fold("Ăn")).toBe("an");
	});

	it("is idempotent", () => {
		for (const vector of vectors) {
			expect(fold(vector.fold)).toBe(vector.fold);
		}
	});

	it("does not trim U+FEFF, which is not White_Space", () => {
		expect(fold("﻿a ")).toBe("﻿a");
	});
});

describe("searchText", () => {
	it("joins the tokens with single spaces and drops everything between them", () => {
		expect(searchText("Giá: 1.250.000₫")).toBe("gia 1.250.000");
		expect(searchText("日本語のテキスト")).toBe("日 本 語 の テキスト");
		expect(searchText("a.b.c. Hello, World!")).toBe("a.b.c hello world");
		expect(searchText(" 👍🏽 ... ")).toBe("");
	});
});

describe("tokens", () => {
	it("applies default UAX #29 rules instead of ICU dictionaries", () => {
		expect(tokens("中文分词")).toEqual(["中", "文", "分", "词"]);
		expect(tokens("カタカナテスト")).toEqual(["カタカナテスト"]);
		expect(tokens("ภาษาไทย")).toEqual(["ภ", "า", "ษ", "า", "ไ", "ท", "ย"]);
	});

	it("keeps digits of dictionary scripts together", () => {
		expect(tokens("๑๒๓ บาท")).toEqual(["๑๒๓", "บ", "า", "ท"]);
	});

	it("drops segments without a letter or digit", () => {
		expect(tokens("👍🏽 ... !!!")).toEqual([]);
		expect(tokens("")).toEqual([]);
	});
});
