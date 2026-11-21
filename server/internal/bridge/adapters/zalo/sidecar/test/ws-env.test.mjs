import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.join(here, "..", "dist", "zalo-sidecar.cjs");
/** An empty environment; Node on Windows cannot start without SYSTEMROOT. */
const empty = process.platform === "win32" ? { SYSTEMROOT: process.env.SYSTEMROOT } : {};

test("the module sets both ws switches", () => {
	const result = spawnSync(
		process.execPath,
		["--input-type=module", "-e", `await import(${JSON.stringify(new URL("../src/ws-env.mjs", import.meta.url).href)}); console.log(process.env.WS_NO_BUFFER_UTIL, process.env.WS_NO_UTF_8_VALIDATE)`],
		{ env: empty, encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), "1 1");
});

test("the module is the first one of the entry, before any other import", () => {
	const entry = readFileSync(path.join(here, "..", "src", "entry.mjs"), "utf8");
	const imports = entry.split("\n").filter((line) => line.startsWith("import "));
	assert.equal(imports[0], 'import "./ws-env.mjs";');
});

/** Runs the built bundle with an empty environment and records every module it tries to load by name. */
function loadsOfBundle(env) {
	const dir = mkdtempSync(path.join(tmpdir(), "zalo-ws-env-"));
	try {
		const hook = path.join(dir, "record-loads.cjs");
		writeFileSync(
			hook,
			`const Module = require("node:module");
const load = Module._load;
Module._load = function (request, ...rest) {
	if (request === "bufferutil" || request === "utf-8-validate") process.stderr.write("load " + request + "\\n");
	return load.call(this, request, ...rest);
};`,
		);
		return spawnSync(process.execPath, ["-r", hook, bundle], { env, input: "", encoding: "utf8", timeout: 20000 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("the built bundle never tries the native ws modules, even with an empty environment", () => {
	const run = loadsOfBundle(empty);
	assert.equal(run.status, 0, run.stderr);
	assert.match(run.stdout, /"ev":"ready"/);
	assert.doesNotMatch(run.stderr, /load (bufferutil|utf-8-validate)/);
});

test("the probe works, and the switch comes before ws runs in the bundle", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "zalo-ws-probe-"));
	try {
		// ws's own modules are lazy wrappers; they first run where its ESM wrapper is imported.
		const source = readFileSync(bundle, "utf8");
		const set = source.indexOf('process.env.WS_NO_BUFFER_UTIL = "1"');
		const firstUse = source.indexOf("/ws/wrapper.mjs\n");
		assert.ok(set > 0 && firstUse > 0 && set < firstUse, "the switch is set before ws is first evaluated");
		// The same check as ws's lib/buffer-util.js, alone and with the switch unset: the hook sees the try.
		const probe = path.join(dir, "probe.cjs");
		writeFileSync(probe, 'try { if (!process.env.WS_NO_BUFFER_UTIL) require("bufferutil"); } catch {}');
		const hook = path.join(dir, "record-loads.cjs");
		writeFileSync(hook, 'const M = require("node:module"); const l = M._load; M._load = function (r, ...a) { if (r === "bufferutil") process.stderr.write("load bufferutil\\n"); return l.call(this, r, ...a); };');
		const run = spawnSync(process.execPath, ["-r", hook, probe], { env: empty, encoding: "utf8" });
		assert.match(run.stderr, /load bufferutil/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
