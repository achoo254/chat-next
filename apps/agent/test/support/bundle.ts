import { isBuiltin } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const agentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Bundles an entry of the agent for `node`, so tests can run it as a real
 * second process. Workspace packages are TypeScript sources Node cannot
 * load, so they go into the bundle with the packages they import; the
 * agent's own dependencies load from node_modules, as the bundle sits
 * inside the package. Each caller passes its own name so parallel test
 * files never write the same bundle.
 */
export async function bundleForNode(entry: string, name: string): Promise<string> {
	const outfile = join(agentRoot, "node_modules/.cache/agent-test", name, "main.mjs");
	await build({
		entryPoints: [resolve(agentRoot, entry)],
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		outfile,
		logLevel: "silent",
		// Bundled CommonJS packages (tweetnacl) call require() for built-ins.
		banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
		plugins: [
			{
				name: "external-packages",
				setup(b) {
					b.onResolve({ filter: /^[^./]/ }, (args) => {
						if (args.path.startsWith("@achoo254/")) return undefined;
						const fromAgent = args.importer.startsWith(agentRoot + sep) && !args.importer.includes(`${sep}node_modules${sep}`);
						return fromAgent || isBuiltin(args.path) ? { path: args.path, external: true } : undefined;
					});
				},
			},
		],
	});
	return outfile;
}
