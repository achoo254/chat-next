import { describe, expect, it } from "vitest";
import { FTS5_TOKENIZE, searchText } from "../src/index.ts";
import { loadFoldVectors } from "./load-json.ts";

// node:sqlite ships with Node >= 22.13 (flag-free) and its bundled SQLite is
// compiled with FTS5. Older runtimes skip this file with an explicit reason.
const sqlite = await import("node:sqlite").catch(() => undefined);

type Database = InstanceType<NonNullable<typeof sqlite>["DatabaseSync"]>;

/** Quotes a value as an FTS5 string: double quotes are doubled. */
function fts5String(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function openIndex(module: NonNullable<typeof sqlite>): Database {
	const db = new module.DatabaseSync(":memory:");
	db.exec(`CREATE VIRTUAL TABLE doc USING fts5(body, tokenize = ${fts5String(FTS5_TOKENIZE)})`);
	db.exec("CREATE VIRTUAL TABLE doc_terms USING fts5vocab(doc, instance)");
	return db;
}

/** FTS5 terms of every row, in token order. */
function termsByRow(db: Database): Map<number, string[]> {
	const rows = db.prepare("SELECT doc, term FROM doc_terms ORDER BY doc, offset").all();
	const terms = new Map<number, string[]>();
	for (const row of rows) {
		const doc = Number(row.doc);
		const term = String(row.term);
		const list = terms.get(doc);
		if (list === undefined) terms.set(doc, [term]);
		else list.push(term);
	}
	return terms;
}

const vectors = loadFoldVectors();

if (sqlite === undefined) {
	describe("FTS5 tokenizer parity", () => {
		it.skip("node:sqlite is not available in this runtime (needs Node >= 22.13)", () => undefined);
	});
} else {
	const module = sqlite;

	describe("FTS5 tokenizer parity", () => {
		it("FTS5 splits searchText(input) into exactly tokens(input) for every vector", () => {
			const db = openIndex(module);
			const insert = db.prepare("INSERT INTO doc(rowid, body) VALUES (?, ?)");
			vectors.forEach((vector, index) => insert.run(index + 1, searchText(vector.input)));
			const terms = termsByRow(db);
			vectors.forEach((vector, index) => {
				expect(terms.get(index + 1) ?? [], JSON.stringify(vector.input)).toEqual(vector.tokens);
			});
			db.close();
		});

		it("finds every vector by its own query, token by token", () => {
			const db = openIndex(module);
			const insert = db.prepare("INSERT INTO doc(rowid, body) VALUES (?, ?)");
			vectors.forEach((vector, index) => insert.run(index + 1, searchText(vector.input)));
			const match = db.prepare("SELECT rowid FROM doc WHERE doc MATCH ?");
			vectors.forEach((vector, index) => {
				const text = searchText(vector.input);
				if (text === "") return;
				const query = text.split(" ").map(fts5String).join(" ");
				const rowids = match.all(query).map((row) => Number(row.rowid));
				expect(rowids, JSON.stringify(vector.input)).toContain(index + 1);
			});
			db.close();
		});

		// searchText never contains White_Space other than U+0020 (fold collapses
		// it), so this sweep proves the vector result for any input: only the
		// joining space can split a token.
		it("treats every code point except White_Space as a token character", () => {
			const db = openIndex(module);
			const insert = db.prepare("INSERT INTO doc(rowid, body) VALUES (?, ?)");
			const whiteSpace = /\p{White_Space}/u;
			const probed: number[] = [];
			db.exec("BEGIN");
			for (let cp = 1; cp <= 0x10ffff; cp++) {
				if (cp >= 0xd800 && cp <= 0xdfff) continue;
				const char = String.fromCodePoint(cp);
				if (whiteSpace.test(char)) continue;
				insert.run(cp, `a${char}a`);
				probed.push(cp);
			}
			insert.run(0x110000, "a a");
			db.exec("COMMIT");

			const counts = new Map<number, number>();
			for (const row of db.prepare("SELECT doc, count(*) AS n FROM doc_terms GROUP BY doc").all()) {
				counts.set(Number(row.doc), Number(row.n));
			}
			const separators = probed.filter((cp) => counts.get(cp) !== 1).map((cp) => cp.toString(16));
			expect(separators).toEqual([]);
			expect(counts.get(0x110000)).toBe(2);
			db.close();
			// Sweeps all of Unicode through SQLite: seconds on a shared CI runner.
		}, 60_000);
	});
}
