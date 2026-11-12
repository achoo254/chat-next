// Fails when a tracked file (code, tests, docs, plans: everything git tracks)
// contains a string this public repo must never hold. The list itself stays
// out of the repo: FORBIDDEN_PATTERNS holds one regular expression per line
// (case-insensitive; a line that is not a valid expression is matched as plain
// text). Output names only file:line and the pattern's number in that list,
// never the pattern or the matched text, so a CI log does not leak either.
// Without the variable (fork pull requests get no secrets) it is a no-op.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ENV_NAME = "FORBIDDEN_PATTERNS";

export interface Hit {
	path: string;
	/** 1-based line number. */
	line: number;
	/** 1-based number of the pattern among the non-empty lines of the list. */
	pattern: number;
}

export interface Pattern {
	/** 1-based, as reported in hits. */
	index: number;
	re: RegExp;
	/** True when the line was not a valid expression and is matched literally. */
	literal: boolean;
}

/** One pattern per non-empty line; surrounding whitespace and CR are ignored. */
export function parsePatterns(raw: string): Pattern[] {
	const lines = raw
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l !== "");
	return lines.map((source, i) => {
		try {
			return { index: i + 1, re: new RegExp(source, "i"), literal: false };
		} catch {
			const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return { index: i + 1, re: new RegExp(escaped, "i"), literal: true };
		}
	});
}

/** Binary files (a NUL byte in the first 8 KB) are not scanned. */
export function isBinary(buf: Buffer): boolean {
	return buf.subarray(0, 8192).includes(0);
}

export function scanText(path: string, text: string, patterns: readonly Pattern[]): Hit[] {
	const hits: Hit[] = [];
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		for (const p of patterns) {
			if (p.re.test(line)) hits.push({ path, line: i + 1, pattern: p.index });
		}
	}
	return hits;
}

/** Paths git tracks under `root`, relative to it. */
export function trackedFiles(root: string): string[] {
	const out = execFileSync("git", ["ls-files", "-z", "--cached"], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
	return out
		.toString("utf8")
		.split("\0")
		.filter((p) => p !== "");
}

export function scanRepo(root: string, patterns: readonly Pattern[]): Hit[] {
	const hits: Hit[] = [];
	for (const path of trackedFiles(root)) {
		let buf: Buffer;
		try {
			buf = readFileSync(join(root, path));
		} catch {
			continue; // deleted in the working tree, or a submodule directory
		}
		if (isBinary(buf)) continue;
		hits.push(...scanText(path, buf.toString("utf8"), patterns));
	}
	return hits;
}

export interface RunResult {
	code: 0 | 1;
	output: string[];
}

export function run(env: Readonly<Record<string, string | undefined>>, root: string): RunResult {
	const raw = env[ENV_NAME];
	const patterns = raw === undefined ? [] : parsePatterns(raw);
	if (patterns.length === 0) {
		return { code: 0, output: [`check-forbidden-patterns: ${ENV_NAME} is not set; skipped (expected on fork pull requests).`] };
	}
	const output: string[] = [];
	for (const p of patterns) {
		if (p.literal) output.push(`check-forbidden-patterns: pattern #${p.index} is not a valid regular expression; matched as plain text.`);
	}
	const hits = scanRepo(root, patterns);
	for (const h of hits) output.push(`${h.path}:${h.line}: forbidden pattern #${h.pattern}`);
	if (hits.length > 0) {
		output.push(`check-forbidden-patterns: ${hits.length} match(es) of ${patterns.length} pattern(s). Replace them with neutral values (example.com, acme).`);
		return { code: 1, output };
	}
	output.push(`check-forbidden-patterns: ${patterns.length} pattern(s), no match.`);
	return { code: 0, output };
}

function repoRoot(): string {
	return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: fileURLToPath(new URL(".", import.meta.url)) })
		.toString("utf8")
		.trim();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		const result = run(process.env, repoRoot());
		for (const line of result.output) console.log(line);
		process.exitCode = result.code;
	} catch (err) {
		console.error(`check-forbidden-patterns: ${err instanceof Error ? err.message : String(err)}`);
		process.exitCode = 2;
	}
}
