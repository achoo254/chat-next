// A light code highlighter for the AI's code blocks and diffs: comments,
// strings, numbers and keywords of a few language families, found by one
// left-to-right scan. It never builds HTML: it returns text pieces with a
// kind, and React renders them as text. Unknown languages stay plain.

export type PieceKind = "plain" | "comment" | "string" | "number" | "keyword";

export interface Piece {
	readonly kind: PieceKind;
	readonly text: string;
}

interface Family {
	readonly line: readonly string[];
	readonly block: readonly [string, string] | null;
	readonly quotes: string;
	readonly keywords: ReadonlySet<string>;
}

const words = (list: string): ReadonlySet<string> => new Set(list.split(" "));

const JS = words(
	"abstract as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function get if implements import in instanceof interface let new null of private protected public readonly return satisfies set static super switch this throw true try type typeof undefined var void while with yield",
);
const C = words(
	"auto bool break case catch char class const continue default defer delete do double else enum extern false final float fn for func go if impl import int interface let long loop match mod mut namespace new nil null package private protected pub public return self static struct super switch this throw trait true try type typedef use var void where while",
);
const PY = words("and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return self True try while with yield");
const SH = words("case do done elif else esac export fi for function if in local readonly return set then unset until while echo cd exit");
const SQL = words(
	"add alter and as asc by create delete desc distinct drop exists from group having in index inner insert into is join key left like limit not null on or order outer primary references right select set table union unique update values where with",
);
const NONE = words("");

const FAMILIES: Readonly<Record<string, Family>> = {
	js: { line: ["//"], block: ["/*", "*/"], quotes: "\"'`", keywords: JS },
	c: { line: ["//"], block: ["/*", "*/"], quotes: "\"'`", keywords: C },
	py: { line: ["#"], block: null, quotes: "\"'", keywords: PY },
	sh: { line: ["#"], block: null, quotes: "\"'", keywords: SH },
	css: { line: [], block: ["/*", "*/"], quotes: "\"'", keywords: NONE },
	sql: { line: ["--"], block: ["/*", "*/"], quotes: "'\"", keywords: SQL },
	yaml: { line: ["#"], block: null, quotes: "\"'", keywords: words("true false null yes no on off") },
};

const ALIASES: Readonly<Record<string, string>> = {
	js: "js",
	jsx: "js",
	mjs: "js",
	cjs: "js",
	ts: "js",
	tsx: "js",
	mts: "js",
	javascript: "js",
	typescript: "js",
	json: "js",
	jsonc: "js",
	c: "c",
	h: "c",
	cpp: "c",
	cc: "c",
	hpp: "c",
	cs: "c",
	csharp: "c",
	java: "c",
	kt: "c",
	kotlin: "c",
	go: "c",
	rs: "c",
	rust: "c",
	swift: "c",
	php: "c",
	dart: "c",
	py: "py",
	python: "py",
	rb: "py",
	ruby: "py",
	sh: "sh",
	bash: "sh",
	zsh: "sh",
	shell: "sh",
	console: "sh",
	ps1: "sh",
	powershell: "sh",
	dockerfile: "sh",
	makefile: "sh",
	toml: "yaml",
	ini: "yaml",
	css: "css",
	scss: "css",
	less: "css",
	sql: "sql",
	yaml: "yaml",
	yml: "yaml",
};

/** The family of a fence's language or a file's extension; null when unknown. */
export function languageOf(name: string): string | null {
	const key = name.trim().toLowerCase();
	return ALIASES[key] ?? null;
}

/** The family of a file by its name ("src/app.tsx" → "js"). */
export function languageOfPath(path: string): string | null {
	const base = path.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
	if (base === "dockerfile" || base === "makefile") return "sh";
	const dot = base.lastIndexOf(".");
	return dot < 0 ? null : languageOf(base.slice(dot + 1));
}

const IDENT = /[A-Za-z_$][\w$]*/y;
const NUMBER = /(?:0[xX][\da-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/y;

/** Splits `code` into highlighted pieces; one plain piece for an unknown family. */
export function highlight(code: string, family: string | null): Piece[] {
	const lang = family === null ? undefined : FAMILIES[family];
	if (lang === undefined) return [{ kind: "plain", text: code }];
	const out: Piece[] = [];
	let plain = "";
	const push = (kind: PieceKind, text: string) => {
		if (text === "") return;
		if (kind === "plain") {
			plain += text;
			return;
		}
		if (plain !== "") out.push({ kind: "plain", text: plain });
		plain = "";
		out.push({ kind, text });
	};
	const at = (mark: string, index: number) => code.startsWith(mark, index);
	let i = 0;
	while (i < code.length) {
		const lineStart = lang.line.find((mark) => at(mark, i));
		if (lineStart !== undefined) {
			const end = code.indexOf("\n", i);
			const stop = end < 0 ? code.length : end;
			push("comment", code.slice(i, stop));
			i = stop;
			continue;
		}
		if (lang.block !== null && at(lang.block[0], i)) {
			const end = code.indexOf(lang.block[1], i + lang.block[0].length);
			const stop = end < 0 ? code.length : end + lang.block[1].length;
			push("comment", code.slice(i, stop));
			i = stop;
			continue;
		}
		const ch = code.charAt(i);
		if (lang.quotes.includes(ch)) {
			let j = i + 1;
			while (j < code.length && code.charAt(j) !== ch && (ch === "`" || code.charAt(j) !== "\n")) j += code.charAt(j) === "\\" ? 2 : 1;
			const stop = Math.min(code.length, j + 1);
			push("string", code.slice(i, stop));
			i = stop;
			continue;
		}
		if (/\d/.test(ch) && !/[\w$]/.test(code.charAt(i - 1))) {
			NUMBER.lastIndex = i;
			const match = NUMBER.exec(code);
			if (match !== null && match[0] !== "") {
				push("number", match[0]);
				i += match[0].length;
				continue;
			}
		}
		if (/[A-Za-z_$]/.test(ch)) {
			IDENT.lastIndex = i;
			const word = IDENT.exec(code)?.[0] ?? ch;
			const known = lang.keywords.has(word) || (family === "sql" && lang.keywords.has(word.toLowerCase()));
			push(known ? "keyword" : "plain", word);
			i += word.length;
			continue;
		}
		push("plain", ch);
		i += 1;
	}
	if (plain !== "") out.push({ kind: "plain", text: plain });
	return out;
}
