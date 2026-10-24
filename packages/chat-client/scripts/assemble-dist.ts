// Build of @achoo254/chat-client (pnpm build, after the internal packages
// emitted their own dist/): copies the dist/ of proto-ts, platform, core and
// platform-web into this package's dist/, rewrites their imports of each
// other to relative paths, then checks that every relative import resolves
// inside dist/, that every package dist/ imports is one of this package's
// dependencies (so no internal package is left), that those dependencies
// are exactly the third-party ones the bundled packages declare, and that
// every target of the exports map exists.
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED, importedPackages, INTERNAL_PREFIX, relativeImports, rewriteSpecifiers } from "./rewrite-specifiers.ts";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = dirname(packageDir);
const dist = join(packageDir, "dist");

interface Manifest {
	dependencies?: Record<string, string>;
	exports?: Record<string, string | Record<string, string>>;
}

function readManifest(dir: string): Manifest {
	return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;
}

/** The bundled packages' third-party dependencies must be this package's dependencies, same versions. */
function checkDependencies(): void {
	const expected = new Map<string, string>();
	for (const { packageDir: name } of BUNDLED) {
		for (const [dep, range] of Object.entries(readManifest(join(packagesDir, name)).dependencies ?? {})) {
			if (dep.startsWith(INTERNAL_PREFIX)) continue;
			const seen = expected.get(dep);
			if (seen !== undefined && seen !== range) throw new Error(`${dep}: packages/* disagree (${seen} vs ${range})`);
			expected.set(dep, range);
		}
	}
	const actual = readManifest(packageDir).dependencies ?? {};
	const problems: string[] = [];
	for (const [dep, range] of expected) {
		if (actual[dep] !== range) problems.push(`${dep}: expected ${range}, found ${actual[dep] ?? "nothing"}`);
	}
	for (const dep of Object.keys(actual)) {
		if (!expected.has(dep)) problems.push(`${dep}: not used by the bundled packages`);
	}
	if (problems.length > 0) throw new Error(`packages/chat-client/package.json dependencies:\n  ${problems.join("\n  ")}`);
}

function copyEmitted(): void {
	rmSync(dist, { recursive: true, force: true });
	for (const { packageDir: name, emitted, into } of BUNDLED) {
		const from = join(packagesDir, name, emitted);
		if (!existsSync(from)) throw new Error(`${from} is missing: build packages/${name} first`);
		cpSync(from, join(dist, into), { recursive: true });
	}
}

function emittedFiles(): string[] {
	return readdirSync(dist, { recursive: true, encoding: "utf8" })
		.map((path) => path.split(sep).join("/"))
		.filter((path) => path.endsWith(".js") || path.endsWith(".d.ts"));
}

function rewriteAndCheck(): number {
	const files = emittedFiles();
	const present = new Set(files);
	const dependencies = new Set(Object.keys(readManifest(packageDir).dependencies ?? {}));
	const problems: string[] = [];
	for (const file of files) {
		const path = join(dist, file);
		const code = rewriteSpecifiers(readFileSync(path, "utf8"), file);
		writeFileSync(path, code);
		for (const target of relativeImports(code, file)) {
			if (!present.has(target)) problems.push(`${file}: imports ${target}, which is not in dist/`);
		}
		for (const name of importedPackages(code)) {
			if (!dependencies.has(name)) problems.push(`${file}: imports ${name}, which is not a dependency`);
		}
	}
	if (problems.length > 0) throw new Error(`dist/ is not self-contained:\n  ${problems.join("\n  ")}`);
	return files.length;
}

/** Every exports target is a file of the package; a "*" pattern matches at least one dist/ file. */
function checkExports(files: readonly string[]): void {
	const problems: string[] = [];
	for (const [subpath, value] of Object.entries(readManifest(packageDir).exports ?? {})) {
		for (const target of typeof value === "string" ? [value] : Object.values(value)) {
			const path = target.replace(/^\.\//, "");
			if (path.includes("*")) {
				const [head = "", tail = ""] = path.split("*");
				if (!files.some((file) => `dist/${file}`.startsWith(head) && `dist/${file}`.endsWith(tail))) {
					problems.push(`${subpath}: no file matches ${target}`);
				}
			} else if (!existsSync(join(packageDir, path))) {
				problems.push(`${subpath}: ${target} does not exist`);
			}
		}
	}
	if (problems.length > 0) throw new Error(`package.json exports:\n  ${problems.join("\n  ")}`);
}

checkDependencies();
copyEmitted();
const count = rewriteAndCheck();
checkExports(emittedFiles());
console.log(`@achoo254/chat-client: dist/ assembled from ${BUNDLED.length} packages, ${count} files`);
