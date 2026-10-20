/**
 * Fails when a product name is hard-coded outside the brand configuration:
 * - "chat-inet", the repo name used before the *-next rename, anywhere in
 *   product code (any case);
 * - the configured appName as a whole string literal in TS/JS/Go source.
 * Renaming the product must only need brand.config.json and a rebuild.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const brand = JSON.parse(readFileSync(join(root, "brand.config.json"), "utf8"));
const SCANNED = ["apps", "packages", "server", "proto", "sdk", "spec", "deploy"];
const SKIPPED_DIRS = new Set(["node_modules", "dist", "generated", "gen"]);
const SOURCE = /\.(ts|tsx|js|mjs|cjs|go|proto|json|ya?ml|html|css)$/;
const CODE = /\.(ts|tsx|js|mjs|cjs|go)$/;
const TEST_FILE = /(\/test\/|_test\.go$|\.test\.ts$)/;
const folderName = /chat-inet/i;
const escaped = brand.appName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const appNameLiteral = new RegExp(`(["'\`])${escaped}\\1`);

function* files(dir) {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		if (SKIPPED_DIRS.has(name) || name.startsWith(".")) continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) yield* files(path);
		else if (SOURCE.test(name)) yield path;
	}
}

const problems = [];
for (const top of SCANNED) {
	for (const path of files(join(root, top))) {
		const lines = readFileSync(path, "utf8").split("\n");
		lines.forEach((line, index) => {
			const where = `${relative(root, path)}:${index + 1}`;
			if (folderName.test(line)) problems.push(`${where} contains "chat-inet"`);
			if (CODE.test(path) && !TEST_FILE.test(path) && appNameLiteral.test(line)) {
				problems.push(
					`${where} hard-codes the product name "${brand.appName}"; read it from @app/brand`,
				);
			}
		});
	}
}

if (problems.length > 0) {
	console.error(problems.join("\n"));
	process.exit(1);
}
console.log("check-brand: no hard-coded product name");
