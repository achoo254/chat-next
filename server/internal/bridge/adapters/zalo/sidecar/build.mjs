// Builds dist/zalo-sidecar.cjs, the one file the server runs, from src/entry.mjs and the pinned
// packages of pnpm-lock.yaml. The build is deterministic: CI builds it again and the file must
// be byte-identical to the committed one, so what was reviewed is what runs. Also writes the
// SHA-256 of the bundle and the licence notices of every package inside it.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "dist", "zalo-sidecar.cjs");

const result = await build({
	entryPoints: [path.join(here, "src", "entry.mjs")],
	outfile: out,
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node20",
	legalComments: "none",
	alias: { "form-data": path.join(here, "src", "stub-form-data.mjs") },
	metafile: true,
	logLevel: "warning",
});

const bundle = fs.readFileSync(out);
fs.writeFileSync(`${out}.sha256`, `${createHash("sha256").update(bundle).digest("hex")}  zalo-sidecar.cjs\n`);

/** Names of the installed packages that ended up inside the bundle. */
const names = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
	const match = /node_modules\/\.pnpm\/[^/]+\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input.replaceAll("\\", "/"));
	if (match !== null) names.add(match[1]);
}

/** The real directory of an installed package, looked up in pnpm's store. */
function packageRoot(name) {
	const store = path.join(here, "node_modules", ".pnpm");
	for (const entry of fs.readdirSync(store)) {
		const candidate = path.join(store, entry, "node_modules", name);
		if (fs.existsSync(path.join(candidate, "package.json"))) return fs.realpathSync(candidate);
	}
	throw new Error(`package ${name} not found`);
}

// The licence notices MIT and the like ask to keep with a copy.
const notices = [];
for (const name of [...names].sort()) {
	const root = packageRoot(name);
	const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
	const licence = fs.readdirSync(root).find((file) => /^licen[cs]e/i.test(file));
	const text = licence === undefined ? "(no licence file in the package)" : fs.readFileSync(path.join(root, licence), "utf8").trim();
	notices.push(`${pkg.name}@${pkg.version} (${typeof pkg.license === "string" ? pkg.license : JSON.stringify(pkg.license)})\n${text}\n`);
}
fs.writeFileSync(path.join(here, "dist", "THIRD_PARTY_NOTICES.txt"), notices.join(`\n${"-".repeat(72)}\n\n`));
console.log(`built dist/zalo-sidecar.cjs: ${bundle.length} bytes, ${names.size} packages`);
