// Pure helpers of the build (assemble-dist.ts): where each internal workspace
// package lands inside dist/, the rewrite of their bare specifiers
// ("@achoo254/chat-core", "@achoo254/chat-proto/users", ...) into relative
// paths so the published package needs none of them, and the import lists
// the build checks. Imports are read with TypeScript's own scanner, so
// comments and strings that merely look like imports are ignored.
import { posix } from "node:path";
import ts from "typescript";

/** Internal workspace package directory (under packages/) -> its emitted dist and its folder inside dist/. */
export const BUNDLED = [
	{ packageDir: "proto-ts", emitted: "dist/gen/app/v1", into: "proto" },
	{ packageDir: "platform", emitted: "dist", into: "platform" },
	{ packageDir: "core", emitted: "dist", into: "core" },
	{ packageDir: "platform-web", emitted: "dist", into: "web" },
] as const;

export const INTERNAL_PREFIX = "@achoo254/chat-";

const PROTO_SPECIFIER = /^@achoo254\/chat-proto\/([a-z][a-z0-9_]*)$/;

/**
 * The dist-relative file an internal import resolves to: the package entry
 * for chat-core and chat-platform, one generated file per chat-proto subpath.
 * Anything else (chat-platform-web, a deep import) has no place in dist/.
 */
export function bundledTarget(specifier: string): string {
	if (specifier === "@achoo254/chat-core") return "core/index.js";
	if (specifier === "@achoo254/chat-platform") return "platform/index.js";
	const proto = PROTO_SPECIFIER.exec(specifier);
	if (proto !== null) return `proto/${proto[1] ?? ""}_pb.js`;
	throw new Error(`no bundled target for "${specifier}"`);
}

/** Every module specifier one .js or .d.ts file imports: import/export from, import "x", import(), import("x") types. */
export function importSpecifiers(code: string): string[] {
	return ts.preProcessFile(code, true, true).importedFiles.map((file) => file.fileName);
}

/**
 * Rewrites the internal specifiers of one emitted .js or .d.ts file.
 * fileInDist is the file's posix path relative to dist/ (e.g. "web/client.d.ts").
 * Throws on an internal specifier that has no place in dist/.
 */
export function rewriteSpecifiers(code: string, fileInDist: string): string {
	const from = posix.dirname(fileInDist);
	const internal = new Set(importSpecifiers(code).filter((specifier) => specifier.startsWith(INTERNAL_PREFIX)));
	let rewritten = code;
	for (const specifier of internal) {
		const relative = posix.relative(from, bundledTarget(specifier));
		const replacement = relative.startsWith(".") ? relative : `./${relative}`;
		for (const quote of ['"', "'"]) {
			rewritten = rewritten.split(`${quote}${specifier}${quote}`).join(`${quote}${replacement}${quote}`);
		}
	}
	return rewritten;
}

/**
 * The dist-relative files the relative imports of one emitted file point at;
 * in a .d.ts file "./x.js" and "./x.ts" (tsc keeps the source extension
 * there, which TypeScript resolves) both mean "./x.d.ts".
 */
export function relativeImports(code: string, fileInDist: string): string[] {
	const declaration = fileInDist.endsWith(".d.ts");
	const from = posix.dirname(fileInDist);
	return importSpecifiers(code)
		.filter((specifier) => specifier.startsWith("./") || specifier.startsWith("../"))
		.map((specifier) => {
			const target = posix.normalize(posix.join(from, specifier));
			return declaration && !target.endsWith(".d.ts") ? target.replace(/\.[jt]s$/, ".d.ts") : target;
		});
}

/**
 * The packages one emitted file imports ("@bufbuild/protobuf" for
 * "@bufbuild/protobuf/codegenv2"), without relative and node: imports;
 * each must be a dependency of the published package.
 */
export function importedPackages(code: string): string[] {
	return importSpecifiers(code)
		.filter((specifier) => !specifier.startsWith(".") && !specifier.startsWith("node:"))
		.map((specifier) => {
			const parts = specifier.split("/");
			return (specifier.startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1)).join("/");
		});
}
