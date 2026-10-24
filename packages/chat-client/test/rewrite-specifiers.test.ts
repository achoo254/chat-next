import { describe, expect, it } from "vitest";
import {
	bundledTarget,
	importedPackages,
	importSpecifiers,
	relativeImports,
	rewriteSpecifiers,
} from "../scripts/rewrite-specifiers.ts";

describe("bundledTarget", () => {
	it("maps the package entries and the proto files", () => {
		expect(bundledTarget("@achoo254/chat-core")).toBe("core/index.js");
		expect(bundledTarget("@achoo254/chat-platform")).toBe("platform/index.js");
		expect(bundledTarget("@achoo254/chat-proto/bot_admin")).toBe("proto/bot_admin_pb.js");
	});

	it("rejects what dist/ does not hold", () => {
		expect(() => bundledTarget("@achoo254/chat-platform-web")).toThrow(/chat-platform-web/);
		expect(() => bundledTarget("@achoo254/chat-core/src/index.ts")).toThrow(/chat-core\/src/);
		expect(() => bundledTarget("@achoo254/chat-proto")).toThrow(/chat-proto/);
		expect(() => bundledTarget("@achoo254/chat-proto/../core")).toThrow();
		expect(() => bundledTarget("@achoo254/chat-bot-sdk")).toThrow();
	});
});

describe("importSpecifiers", () => {
	it("finds static, side-effect, dynamic and type imports and skips comments and strings", () => {
		const code = [
			`/** e.g. \`import ChatWorker from "@achoo254/chat-client/worker?worker"\`, anything from ':' */`,
			`import { a,`,
			`\tb } from "./a.js";`,
			`export * from "../core/index.js";`,
			`import "side-effect";`,
			`export declare const t: import("@connectrpc/connect").Client<never>;`,
			`const lazy = await import("./lazy.js");`,
			`// import z from "commented";`,
			`const s = 'import x from "in-a-string"';`,
		].join("\n");
		expect(importSpecifiers(code)).toEqual([
			"./a.js",
			"../core/index.js",
			"side-effect",
			"@connectrpc/connect",
			"./lazy.js",
		]);
	});
});

describe("rewriteSpecifiers", () => {
	it("rewrites imports, exports and import() types relative to the file", () => {
		const code = [
			`import { startApp } from "@achoo254/chat-core";`,
			`import { systemTimers } from '@achoo254/chat-platform';`,
			`export type { User } from "@achoo254/chat-proto/users";`,
			`export declare const x: import("@achoo254/chat-proto/messages").Message;`,
		].join("\n");
		expect(rewriteSpecifiers(code, "web/client.d.ts")).toBe(
			[
				`import { startApp } from "../core/index.js";`,
				`import { systemTimers } from '../platform/index.js';`,
				`export type { User } from "../proto/users_pb.js";`,
				`export declare const x: import("../proto/messages_pb.js").Message;`,
			].join("\n"),
		);
	});

	it("walks up from nested files and keeps the leading ./ inside one folder", () => {
		expect(rewriteSpecifiers(`import "@achoo254/chat-proto/auth";`, "core/sync/engine.js")).toBe(
			`import "../../proto/auth_pb.js";`,
		);
		expect(rewriteSpecifiers(`export * from "@achoo254/chat-core";`, "core/index.js")).toBe(
			`export * from "./index.js";`,
		);
	});

	it("leaves other packages and comments alone", () => {
		const code = [
			`import { create } from "@bufbuild/protobuf"; // see @achoo254/chat-core docs`,
			`/** \`import ChatWorker from "@achoo254/chat-client/worker?worker"\` */`,
			`/** not "@achoo254/chat-platform-web" */`,
		].join("\n");
		expect(rewriteSpecifiers(code, "core/a.js")).toBe(code);
	});

	it("fails on an internal import it cannot place", () => {
		expect(() => rewriteSpecifiers(`import x from "@achoo254/chat-platform-web";`, "core/a.js")).toThrow();
	});
});

describe("relativeImports", () => {
	it("resolves .js targets for code and .d.ts targets for declarations", () => {
		const code = `import { a } from "./a.js";\nexport * from "../core/index.js";\ntype T = import("./t.js").T;`;
		expect(relativeImports(code, "web/client.js")).toEqual(["web/a.js", "core/index.js", "web/t.js"]);
		expect(relativeImports(code, "web/client.d.ts")).toEqual(["web/a.d.ts", "core/index.d.ts", "web/t.d.ts"]);
	});

	it("reads the .ts extensions tsc keeps in declarations as .d.ts", () => {
		const code = `import type { Chat } from "../model/types.ts";`;
		expect(relativeImports(code, "core/app/start-app.d.ts")).toEqual(["core/model/types.d.ts"]);
	});

	it("ignores bare specifiers", () => {
		expect(relativeImports(`import { createClient } from "@connectrpc/connect";`, "core/a.js")).toEqual([]);
	});
});

describe("importedPackages", () => {
	it("names the package of each bare specifier, scoped or not, ignoring relative and node: ones", () => {
		const code = [
			`import { create } from "@bufbuild/protobuf";`,
			`import { file_x } from "@bufbuild/protobuf/codegenv2";`,
			`import sqlite3InitModule from "@sqlite.org/sqlite-wasm";`,
			`import lodash from "lodash/fp";`,
			`import { a } from "./a.js";`,
			`import { readFile } from "node:fs";`,
			`type T = import("@connectrpc/connect").Client<never>;`,
			`import { startApp } from "@achoo254/chat-core";`,
		].join("\n");
		expect(importedPackages(code)).toEqual([
			"@bufbuild/protobuf",
			"@bufbuild/protobuf",
			"@sqlite.org/sqlite-wasm",
			"lodash",
			"@connectrpc/connect",
			"@achoo254/chat-core",
		]);
	});
});
