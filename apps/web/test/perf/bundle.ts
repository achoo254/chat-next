// What the browser loads at startup, from Vite's build manifest: the entry
// chunk with its static imports, plus the lazy modules a signed-in start
// always loads (STARTUP_MODULES) with theirs.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

export interface ManifestChunk {
	readonly file: string;
	readonly src?: string;
	readonly isEntry?: boolean;
	readonly imports?: readonly string[];
	readonly dynamicImports?: readonly string[];
	readonly css?: readonly string[];
}

export type Manifest = Readonly<Record<string, ManifestChunk>>;

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isChunk(value: unknown): value is ManifestChunk {
	if (typeof value !== "object" || value === null) return false;
	const chunk = value as Record<string, unknown>;
	return (
		typeof chunk.file === "string" &&
		(chunk.imports === undefined || isStringArray(chunk.imports)) &&
		(chunk.dynamicImports === undefined || isStringArray(chunk.dynamicImports)) &&
		(chunk.css === undefined || isStringArray(chunk.css))
	);
}

/** Validates a parsed .vite/manifest.json. */
export function parseManifest(json: unknown): Manifest {
	if (typeof json !== "object" || json === null || Array.isArray(json)) throw new Error("bundle: manifest is not an object");
	for (const [key, chunk] of Object.entries(json)) {
		if (!isChunk(chunk)) throw new Error(`bundle: manifest entry ${key} has an unexpected shape`);
	}
	return json as Manifest;
}

export interface StartupFiles {
	readonly js: readonly string[];
	readonly css: readonly string[];
}

/**
 * Files loaded at startup: every entry chunk and each of `lazyModules`
 * (manifest keys: source paths relative to the Vite root), each with all
 * its static imports. Throws when a lazy module is not in the manifest, so a
 * rename cannot silently shrink what the budget counts.
 */
export function startupFiles(manifest: Manifest, lazyModules: readonly string[]): StartupFiles {
	const roots = Object.keys(manifest).filter((key) => manifest[key]?.isEntry === true);
	if (roots.length === 0) throw new Error("bundle: manifest has no entry chunk");
	for (const module of lazyModules) {
		if (manifest[module] === undefined) throw new Error(`bundle: startup module ${module} is not a chunk in the manifest`);
		roots.push(module);
	}
	const seen = new Set<string>();
	const js = new Set<string>();
	const css = new Set<string>();
	const visit = (key: string) => {
		if (seen.has(key)) return;
		seen.add(key);
		const chunk = manifest[key];
		if (chunk === undefined) throw new Error(`bundle: manifest misses imported chunk ${key}`);
		if (chunk.file.endsWith(".js")) js.add(chunk.file);
		for (const file of chunk.css ?? []) css.add(file);
		for (const imported of chunk.imports ?? []) visit(imported);
	};
	roots.forEach(visit);
	return { js: [...js].sort(), css: [...css].sort() };
}

export interface SizedFile {
	readonly file: string;
	readonly bytes: number;
	readonly gzipBytes: number;
}

/** Raw and gzip (level 9, as Vite reports) sizes of `files` under `outDir`. */
export async function measure(outDir: string, files: readonly string[]): Promise<SizedFile[]> {
	return Promise.all(
		files.map(async (file) => {
			const content = await readFile(join(outDir, file));
			return { file, bytes: content.byteLength, gzipBytes: gzipSync(content, { level: 9 }).byteLength };
		}),
	);
}

export function totalGzip(files: readonly SizedFile[]): number {
	return files.reduce((sum, file) => sum + file.gzipBytes, 0);
}
