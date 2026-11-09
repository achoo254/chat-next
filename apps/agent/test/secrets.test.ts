// Sign-in secrets: Claude gets references, never values. The value a device
// types reaches the machine in one frame, is sealed or kept for the session,
// and never comes back in a frame, a journal item, a tool result, the
// consent log or the files next to it; it is filled only into a page of its
// own site, and a command gets it in its environment only after approval.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { join } from "node:path";
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { toBinary } from "@bufbuild/protobuf";
import { ErrorReason, FrameSchema, ThreadState } from "@achoo254/chat-proto/remote/remote";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type WebSocket as WsSocket, WebSocketServer } from "ws";
import { runSecrets } from "../src/commands/secrets.ts";
import { ConfigStore } from "../src/config.ts";
import { McpHost } from "../src/mcp/mcp-host.ts";
import { forgetSecrets, redact, redactDeep, redactSecrets, rememberSecret, secretVariants } from "../src/mcp/redact.ts";
import { createClaudeProvider, secretCommandHook, secretOutputHook, secretRequestHook } from "../src/providers/claude/index.ts";
import type { ProviderEvent } from "../src/providers/types.ts";
import { AuditLog } from "../src/safety/audit-log.ts";
import { portsFromCommandLines } from "../src/sign-in-secrets/cdp-fill.ts";
import { SessionSecretEnv } from "../src/sign-in-secrets/secret-env.ts";
import { envNamesIn, normalizeOrigin } from "../src/sign-in-secrets/secret-names.ts";
import { type SecretPromptInfo, SecretService } from "../src/sign-in-secrets/secret-service.ts";
import { SecretStore, secretsFile } from "../src/sign-in-secrets/secret-store.ts";
import { Channel } from "../src/util/channel.ts";
import { tempDir } from "./harness.ts";
import { pairedDevice } from "./support/device-link.ts";

process.env.TUNELO_KEYSTORE = "file";

const VALUE = "Pa$$w0rd 'quoted' & más";
const session = { key: "ticket-a", threadId: "thread-a" };

function setup(opts: { ttlMs?: number; findDebugPorts?: () => Promise<number[]> } = {}) {
	const dir = tempDir("secrets-");
	const audit = new AuditLog(join(dir, "audit.jsonl"));
	const service = new SecretService({ configDir: dir, audit, ...opts });
	const prompts: SecretPromptInfo[] = [];
	const ended: string[] = [];
	service.onEvent((e) => (e.type === "prompt" ? prompts.push(e.prompt) : ended.push(e.requestId)));
	return { dir, audit, service, prompts, ended };
}

/** Every file tunelo wrote in its config folder, read as text. */
function everyFile(dir: string): string {
	const walk = (d: string): string[] =>
		readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [readFileSync(join(d, e.name), "utf8")]));
	return walk(dir).join("\n");
}

async function until(check: () => boolean, ms = 2_000): Promise<void> {
	for (const end = Date.now() + ms; !check(); ) {
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 5));
	}
}

afterEach(() => forgetSecrets());

describe("redact: secret values", () => {
	it("hides a value as typed and in the forms pages and commands echo it in", () => {
		rememberSecret(VALUE);
		for (const form of secretVariants(VALUE)) expect(redact(`x ${form} y`)).toBe("x [hidden] y");
		expect(redactSecrets(Buffer.from(VALUE).toString("base64"))).toBe("[hidden]");
		expect(redactSecrets(encodeURIComponent(VALUE))).toBe("[hidden]");
		expect(redactSecrets(JSON.stringify({ v: VALUE }))).toBe('{"v":"[hidden]"}');
		expect(redactSecrets("nothing here")).toBe("nothing here");
	});

	it("walks plain values, keeps bytes, and returns the same value when nothing changed", () => {
		rememberSecret(VALUE);
		const clean = { a: ["x", { b: "y" }] };
		expect(redactDeep(clean)).toBe(clean);
		const bytes = new Uint8Array([1, 2, 3]);
		const out = redactDeep({ stdout: `got ${VALUE}`, nested: [{ s: VALUE }], bytes });
		expect(out).toEqual({ stdout: "got [hidden]", nested: [{ s: "[hidden]" }], bytes });
		expect(out.bytes).toBe(bytes);
	});

	it("leaves values too short to hide without cutting words apart", () => {
		rememberSecret("ab");
		expect(redactSecrets("abc ab")).toBe("abc ab");
	});
});

describe("names and sites", () => {
	it("keeps only the origin of a site; https, or http on loopback", () => {
		expect(normalizeOrigin("https://github.com/login?x=1")).toBe("https://github.com");
		expect(normalizeOrigin("http://localhost:5173/a")).toBe("http://localhost:5173");
		expect(() => normalizeOrigin("http://example.com")).toThrow(/https/);
		expect(() => normalizeOrigin("https://u:p@example.com")).toThrow(/user name/);
		expect(() => normalizeOrigin("github.com")).toThrow(/not a URL/);
		expect(() => normalizeOrigin("file:///etc/passwd")).toThrow(/https/);
	});

	it("finds the secrets a command names", () => {
		expect(envNamesIn('curl -u "me:$TUNELO_SECRET_GH" ${TUNELO_SECRET_API_KEY} $TUNELO_SECRET_GH $OTHER')).toEqual(["GH", "API_KEY"]);
		expect(envNamesIn("echo $tunelo_secret_x")).toEqual([]);
	});

	it("reads a browser's debugging port from its command line or its DevToolsActivePort", () => {
		const files: Record<string, string> = { "/p/DevToolsActivePort": "53001\n/devtools/browser/x" };
		const ports = portsFromCommandLines(
			["chrome --remote-debugging-port=9222 --user-data-dir=/a", "chrome --remote-debugging-port=0 --user-data-dir=/p", "chrome --remote-debugging-pipe", "node app.js"],
			(p) => {
				const text = files[p];
				if (text === undefined) throw new Error("ENOENT");
				return text;
			},
		);
		expect(ports.sort()).toEqual([53001, 9222]);
	});
});

describe("the store", () => {
	it("seals saved values: the file holds no value, a moved entry does not open", async () => {
		const dir = tempDir("store-");
		const store = new SecretStore(dir);
		const held = await store.save("https://github.com", "GH_PASSWORD", VALUE);
		expect(readFileSync(secretsFile(dir), "utf8")).not.toContain(VALUE);
		expect(everyFile(dir)).not.toContain(VALUE);
		expect(await store.reveal(held.id)).toBe(VALUE);
		expect(store.list()[0]?.lastUsedAt).toBeGreaterThan(0);

		const file = JSON.parse(readFileSync(secretsFile(dir), "utf8")) as { secrets: { origin: string }[] };
		const first = file.secrets[0];
		if (!first) throw new Error("no entry");
		first.origin = "https://evil.example";
		await import("node:fs").then((fs) => fs.writeFileSync(secretsFile(dir), JSON.stringify(file)));
		await expect(store.reveal(held.id)).rejects.toThrow(/does not belong/);
	});

	it("keeps one-time values in memory only, until their session ends", async () => {
		const dir = tempDir("store-");
		const store = new SecretStore(dir);
		const held = store.keepOnce("ticket", "https://a.example", "TOKEN", VALUE);
		expect(await store.reveal(held.id)).toBe(VALUE);
		store.endSession("ticket");
		expect(await store.reveal(held.id)).toBeUndefined();
	});
});

describe("request_secret", () => {
	it("asks the devices, then gives a reference only; the consent log has no value", async () => {
		const { service, prompts, ended, dir } = setup();
		const pending = service.request(session, { name: "GH_PASSWORD", purpose: "sign in to run the e2e test", origin: "https://github.com/login" });
		await until(() => prompts.length === 1);
		expect(prompts[0]).toMatchObject({ threadId: "thread-a", name: "GH_PASSWORD", origin: "https://github.com", purpose: "sign in to run the e2e test" });
		await service.provide(prompts[0]?.requestId ?? "", VALUE, true, "phone");
		const ref = await pending;
		expect(ref).toMatchObject({ name: "GH_PASSWORD", origin: "https://github.com", saved: true, env: "$TUNELO_SECRET_GH_PASSWORD" });
		expect(ref.ref).toMatch(/^secret:\/\//);
		expect(JSON.stringify(ref)).not.toContain(VALUE);
		expect(ended).toEqual([prompts[0]?.requestId]);
		expect(everyFile(dir)).not.toContain(VALUE);
		const log = readFileSync(join(dir, "audit.jsonl"), "utf8");
		expect(log).toContain('"action":"secret_add"');
		expect(log).toContain("GH_PASSWORD saved");

		// Saved: the next session gets it without asking anyone.
		const again = await service.request({ key: "ticket-b", threadId: "thread-b" }, { name: "GH_PASSWORD", purpose: "again", origin: "https://github.com" });
		expect(again.ref).toBe(ref.ref);
		expect(prompts).toHaveLength(1);
	});

	it("says when the user declined, nobody answered, or the session ended", async () => {
		const { service, prompts } = setup({ ttlMs: 50 });
		const declined = service.request(session, { name: "A", purpose: "p", origin: "https://a.example" });
		await until(() => prompts.length === 1);
		service.decline(prompts[0]?.requestId ?? "");
		await expect(declined).rejects.toThrow(/declined/);

		await expect(service.request(session, { name: "B", purpose: "p", origin: "https://a.example" })).rejects.toThrow(/nobody entered B/);

		const ending = service.request({ key: "t2", threadId: "th2" }, { name: "C", purpose: "p", origin: "https://a.example" });
		await until(() => prompts.length === 3);
		service.endSession("t2");
		await expect(ending).rejects.toThrow(/session ended/);
		await expect(service.provide(prompts[2]?.requestId ?? "", VALUE, false, "phone")).rejects.toThrow(/no longer open/);
	});

	it("refuses bad names, sites and values", async () => {
		const { service, prompts } = setup();
		await expect(service.request(session, { name: "lower", purpose: "p", origin: "https://a.example" })).rejects.toThrow(/upper-case/);
		await expect(service.request(session, { name: "A", purpose: "p", origin: "http://a.example" })).rejects.toThrow(/https/);
		const pending = service.request(session, { name: "A", purpose: "p", origin: "https://a.example" });
		await until(() => prompts.length === 1);
		await expect(service.provide(prompts[0]?.requestId ?? "", "two\nlines", false, "phone")).rejects.toThrow(/control/);
		await expect(service.provide(prompts[0]?.requestId ?? "", "", false, "phone")).rejects.toThrow(/empty/);
		await service.provide(prompts[0]?.requestId ?? "", VALUE, false, "phone");
		expect((await pending).saved).toBe(false);
	});
});

/** A browser's debugging endpoint: /json/list and one page whose script answers as the test says. */
class FakeBrowser {
	server!: Server;
	wss!: WebSocketServer;
	port = 0;
	pageUrl = "https://github.com/login";
	/** What the page's own `location.origin` is when the script runs. */
	pageOrigin = "https://github.com";
	filled: { selector: unknown; origin: unknown; value: unknown }[] = [];

	async start(): Promise<void> {
		this.wss = new WebSocketServer({ noServer: true });
		this.server = createServer((req, res) => {
			if (req.url === "/json/list") {
				res.writeHead(200, { "content-type": "application/json" }).end(
					JSON.stringify([{ type: "page", url: this.pageUrl, webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}/devtools/page/1` }]),
				);
			} else res.writeHead(404).end();
		});
		this.server.on("upgrade", (req, socket, head) => this.wss.handleUpgrade(req, socket, head, (ws) => this.page(ws)));
		await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
		this.port = (this.server.address() as { port: number }).port;
	}

	private page(ws: WsSocket): void {
		ws.on("message", (data) => {
			const msg = JSON.parse(String(data)) as { id: number; method: string; params: { arguments?: { value: unknown }[] } };
			if (msg.method === "Runtime.evaluate") return ws.send(JSON.stringify({ id: msg.id, result: { result: { objectId: "g1" } } }));
			const [selector, origin, value] = (msg.params.arguments ?? []).map((a) => a.value);
			if (origin !== this.pageOrigin) return ws.send(JSON.stringify({ id: msg.id, result: { result: { value: { ok: false, why: "origin", origin: this.pageOrigin } } } }));
			this.filled.push({ selector, origin, value });
			ws.send(JSON.stringify({ id: msg.id, result: { result: { value: { ok: true, field: "password" } } } }));
		});
	}

	close(): void {
		this.wss.close();
		this.server.close();
	}
}

describe("fill_secret", () => {
	const browser = new FakeBrowser();
	beforeAll(() => browser.start());
	afterAll(() => browser.close());

	async function given(service: SecretService, prompts: SecretPromptInfo[], origin: string, name = "GH_PASSWORD") {
		const pending = service.request(session, { name, purpose: "p", origin });
		await until(() => prompts.some((p) => p.name === name && p.origin === origin));
		const prompt = prompts.find((p) => p.name === name && p.origin === origin);
		await service.provide(prompt?.requestId ?? "", VALUE, false, "phone");
		return pending;
	}

	it("fills a page of the secret's own site, and logs the use without the value", async () => {
		const { service, prompts, dir } = setup({ findDebugPorts: async () => [browser.port] });
		const ref = await given(service, prompts, "https://github.com");
		browser.pageUrl = "https://github.com/login";
		browser.pageOrigin = "https://github.com";
		const out = await service.fill(session, { ref: ref.ref, selector: "#password" });
		expect(out).toEqual({ filled: "password", page: "https://github.com" });
		expect(browser.filled.at(-1)).toEqual({ selector: "#password", origin: "https://github.com", value: VALUE });
		expect(JSON.stringify(out)).not.toContain(VALUE);
		const log = readFileSync(join(dir, "audit.jsonl"), "utf8");
		expect(log).toContain("GH_PASSWORD fill");
		expect(log).not.toContain(VALUE);
	});

	it("refuses a page of another site, and a page that moved before the fill", async () => {
		const { service, prompts } = setup({ findDebugPorts: async () => [browser.port] });
		const ref = await given(service, prompts, "https://github.com");
		const before = browser.filled.length;
		browser.pageUrl = "https://evil.example/login";
		browser.pageOrigin = "https://evil.example";
		await expect(service.fill(session, { ref: ref.ref })).rejects.toThrow(/no page of https:\/\/github.com/);
		// The list said github.com, the page itself is elsewhere by now.
		browser.pageUrl = "https://github.com/login";
		await expect(service.fill(session, { ref: ref.ref })).rejects.toThrow(/moved to https:\/\/evil.example/);
		expect(browser.filled.length).toBe(before);
	});

	it("only takes references this session was given, and says when no browser can be reached", async () => {
		const { service, prompts } = setup({ findDebugPorts: async () => [] });
		const ref = await given(service, prompts, "https://github.com");
		await expect(service.fill({ key: "other", threadId: "x" }, { ref: ref.ref })).rejects.toThrow(/not a secret reference this session was given/);
		await expect(service.fill(session, { ref: ref.ref })).rejects.toThrow(/debugging port.*TUNELO_SECRET_/);
		await expect(service.fill(session, { ref: ref.ref, cdpUrl: "http://10.0.0.5:9222" })).rejects.toThrow(/on this machine/);
	});
});

describe("secrets in commands", () => {
	type Hook = ReturnType<typeof secretCommandHook>;
	const call = (hook: Hook, input: Record<string, unknown>) => hook(input as Parameters<Hook>[0], undefined, { signal: new AbortController().signal });
	const pre = (command: string, mode: string, id = "tu1") => ({
		hook_event_name: "PreToolUse",
		tool_name: "Bash",
		tool_input: { command },
		tool_use_id: id,
		permission_mode: mode,
		session_id: "s",
		transcript_path: "",
		cwd: "/",
	});

	async function givenEnv() {
		const ctx = setup();
		const pending = ctx.service.request(session, { name: "API_TOKEN", purpose: "p", origin: "https://api.example" });
		await until(() => ctx.prompts.length === 1);
		await ctx.service.provide(ctx.prompts[0]?.requestId ?? "", VALUE, false, "phone");
		await pending;
		const env = new SessionSecretEnv(ctx.service, session, join(ctx.dir, "data"), undefined);
		const values = () => {
			const d = join(ctx.dir, "data", "secret-env");
			const f = readdirSync(d).find((x) => x.endsWith(".vars")) ?? "";
			return readFileSync(join(d, f), "utf8");
		};
		return { ...ctx, env, values };
	}

	it("asks before a command that uses a secret; the command's shell reads it, nothing else holds it", async () => {
		const { env, values, dir } = await givenEnv();
		const hook = secretCommandHook(env);
		const command = 'printf %s "$TUNELO_SECRET_API_TOKEN"';
		expect(await call(hook, pre(command, "default"))).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
		expect(values()).toBe("");
		// Approved on the device (canUseTool), then the shell runs Claude Code's loader first.
		await env.beforeCommand("tu1", command);
		const out = execFileSync("bash", ["-c", `. '${env.loader}'; ${command}`], { encoding: "utf8" });
		expect(out).toBe(VALUE);
		expect(command).not.toContain(VALUE);
		env.afterCommand("tu1");
		expect(values()).toBe("");
		expect(execFileSync("bash", ["-c", `. '${env.loader}'; printf %s "\${TUNELO_SECRET_API_TOKEN:-unset}"`], { encoding: "utf8" })).toBe("unset");
		expect(readFileSync(join(dir, "audit.jsonl"), "utf8")).toContain("API_TOKEN env");
		env.dispose();
		expect(readdirSync(join(dir, "data", "secret-env"))).toEqual([]);
	});

	it("in bypassPermissions puts the secrets in at once; names not given are pointed out", async () => {
		const { env, values } = await givenEnv();
		const hook = secretCommandHook(env);
		expect(await call(hook, pre("echo $TUNELO_SECRET_API_TOKEN", "bypassPermissions", "tu2"))).toEqual({});
		expect(values()).toContain("TUNELO_SECRET_API_TOKEN");
		await secretOutputHook(env)(
			{ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: {}, tool_use_id: "tu2", error: "x" } as unknown as Parameters<Hook>[0],
			undefined,
			{ signal: new AbortController().signal },
		);
		expect(values()).toBe("");
		const out = (await call(hook, pre("echo $TUNELO_SECRET_NOT_GIVEN", "default", "tu3"))) as { hookSpecificOutput?: { additionalContext?: string; permissionDecision?: string } };
		expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined();
		expect(out.hookSpecificOutput?.additionalContext).toMatch(/TUNELO_SECRET_NOT_GIVEN is not set: get the secret with request_secret/);
		expect(await call(hook, pre("ls", "default"))).toEqual({});
		env.dispose();
	});

	it("hides a value from every tool output before Claude reads it", async () => {
		const { env, values } = await givenEnv();
		await env.beforeCommand("tu4", "echo $TUNELO_SECRET_API_TOKEN");
		const response = { stdout: `token=${VALUE}\n${Buffer.from(VALUE).toString("base64")}`, stderr: "", interrupted: false };
		const out = (await secretOutputHook(env)(
			{ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: {}, tool_response: response, tool_use_id: "tu4" } as unknown as Parameters<Hook>[0],
			undefined,
			{ signal: new AbortController().signal },
		)) as { hookSpecificOutput?: { updatedToolOutput?: unknown } };
		expect(out.hookSpecificOutput?.updatedToolOutput).toEqual({ stdout: "token=[hidden]\n[hidden]", stderr: "", interrupted: false });
		expect(values()).toBe("");
		const clean = await secretOutputHook(env)(
			{ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {}, tool_response: { file: "x" }, tool_use_id: "tu5" } as unknown as Parameters<Hook>[0],
			undefined,
			{ signal: new AbortController().signal },
		);
		expect(clean).toEqual({});
		env.dispose();
	});

	it("lets request_secret through without a card (the device asks the user itself)", async () => {
		const input = { ...pre("", "default"), tool_name: "mcp__tunelo__request_secret", tool_input: {} };
		expect(await secretRequestHook(input as Parameters<Hook>[0], undefined, { signal: new AbortController().signal })).toMatchObject({
			hookSpecificOutput: { permissionDecision: "allow" },
		});
		const fill = { ...input, tool_name: "mcp__tunelo__fill_secret" };
		expect(await secretRequestHook(fill as Parameters<Hook>[0], undefined, { signal: new AbortController().signal })).toEqual({});
	});
});

describe("the session's events", () => {
	it("never carry a value to the devices or the journal", async () => {
		rememberSecret(VALUE);
		const fake = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): Query => {
			const out = new Channel<SDKMessage>();
			const end = out.close.bind(out);
			void (async () => {
				for await (const _ of params.prompt) {
					out.push({ type: "assistant", parent_tool_use_id: null, uuid: "u1", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "cat token" } }] } } as unknown as SDKMessage);
					out.push({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: `token ${VALUE}` }] } } as unknown as SDKMessage);
					out.push({ type: "assistant", parent_tool_use_id: null, uuid: "u2", message: { id: "m2", content: [{ type: "text", text: `It is ${VALUE}` }] } } as unknown as SDKMessage);
					out.push({ type: "result", subtype: "success", is_error: false, duration_ms: 1 } as unknown as SDKMessage);
					end();
				}
			})();
			return Object.assign(out, {
				interrupt: async () => undefined,
				close: () => end(),
				accountInfo: async () => ({}),
				supportedCommands: async () => [],
				getContextUsage: async () => {
					throw new Error("n/a");
				},
				usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
					throw new Error("n/a");
				},
			}) as unknown as Query;
		};
		const provider = createClaudeProvider({ query: fake, findBinary: async () => "/bin/claude" });
		const s = await provider.start({
			policy: { dir: tempDir(), mcpServers: {}, projectSettings: false, isSensitive: () => false },
			askUser: async () => ({ decision: "allow" }) as never,
		});
		await s.send("go");
		const events: ProviderEvent[] = [];
		for await (const e of s.events) events.push(e);
		const text = JSON.stringify(events);
		expect(text).toContain("[hidden]");
		expect(text).not.toContain(VALUE);
	});
});

describe("over the encrypted link", () => {
	it("prompts every device; the value goes in once and no frame ever brings it back", async () => {
		const { service, dir } = setup();
		const { makeCore } = await import("./harness.ts");
		const { fakeProvider } = await import("./fake-provider.ts");
		const { core } = makeCore([fakeProvider()]);
		const config = new ConfigStore(dir);
		const device = await pairedDevice({ core, config, audit: new AuditLog(join(dir, "audit.jsonl")), secrets: service });
		await device.request("ping", { case: "ping", value: {} });

		const pending = service.request(session, { name: "GH_PASSWORD", purpose: "sign in", origin: "https://github.com" });
		await until(() => device.received.some((f) => f.body.case === "secretPrompt"));
		const prompt = device.received.find((f) => f.body.case === "secretPrompt");
		if (prompt?.body.case !== "secretPrompt") throw new Error("no prompt");
		expect(prompt.body.value).toMatchObject({ threadId: "thread-a", name: "GH_PASSWORD", origin: "https://github.com" });

		const answer = await device.request("p1", { case: "secretProvide", value: { requestId: prompt.body.value.requestId, value: VALUE, remember: true } });
		expect(answer.body.case).toBe("ack");
		await pending;
		await until(() => device.received.some((f) => f.body.case === "secretPromptEnded"));
		const again = await device.request("p2", { case: "secretProvide", value: { requestId: prompt.body.value.requestId, value: VALUE, remember: true } });
		expect(again.body.case === "error" && again.body.value.reason).toBe(ErrorReason.SECRET_PROMPT_GONE);

		const listed = await device.request("l1", { case: "secretList", value: {} });
		expect(listed.body.case === "secretListResult" && listed.body.value.secrets.map((s) => [s.name, s.origin])).toEqual([["GH_PASSWORD", "https://github.com"]]);
		const id = listed.body.case === "secretListResult" ? (listed.body.value.secrets[0]?.id ?? "") : "";

		const removed = await device.request("r1", { case: "secretRemove", value: { id } });
		expect(removed.body.case === "secretListResult" && removed.body.value.secrets).toEqual([]);
		const missing = await device.request("r2", { case: "secretRemove", value: { id } });
		expect(missing.body.case === "error" && missing.body.value.reason).toBe(ErrorReason.SECRET_NOT_FOUND);

		// Not one frame the machine sent holds the value, in any form.
		const sent = device.received.map((f) => Buffer.from(toBinary(FrameSchema, f)).toString("latin1")).join("\n");
		for (const form of secretVariants(VALUE)) expect(sent).not.toContain(form);
		expect(everyFile(dir)).not.toContain(VALUE);
		const log = readFileSync(join(dir, "audit.jsonl"), "utf8");
		expect(log).toContain('"action":"secret_remove"');
	});

	it("a device that connects while a prompt is open gets it", async () => {
		const { service, dir } = setup();
		const { makeCore } = await import("./harness.ts");
		const { fakeProvider } = await import("./fake-provider.ts");
		const { core } = makeCore([fakeProvider()]);
		const pending = service.request(session, { name: "LATE", purpose: "p", origin: "https://a.example" }).catch(() => undefined);
		const device = await pairedDevice({ core, config: new ConfigStore(dir), audit: new AuditLog(join(dir, "audit.jsonl")), secrets: service });
		await device.request("ping", { case: "ping", value: {} });
		expect(device.received.some((f) => f.body.case === "secretPrompt" && f.body.value.name === "LATE")).toBe(true);
		service.close();
		await pending;
	});
});

describe("tunelo's MCP", () => {
	it("offers the secret tools only to a session it opened, and never a value in their results", async () => {
		const { service, prompts, dir } = setup();
		const host = new McpHost(dir, { secrets: () => service, localWrites: () => false, enabledGroups: () => [] });
		const local = host.open("https://tunnel.example");
		expect((await host.call(local, "secrets", "request_secret", { name: "A", purpose: "p", origin: "https://a.example" })).isError).toBe(true);

		const ticket = host.tickets.issue("thread-z");
		const id = host.open("https://tunnel.example", ticket);
		const pending = host.call(id, "secrets", "request_secret", { name: "A", purpose: "p", origin: "https://a.example" });
		await until(() => prompts.length === 1);
		expect(prompts[0]?.threadId).toBe("thread-z");
		await service.provide(prompts[0]?.requestId ?? "", VALUE, false, "phone");
		const result = await pending;
		expect(result.isError).toBeFalsy();
		const text = JSON.stringify(result);
		expect(text).toContain("secret://");
		expect(text).not.toContain(VALUE);
		expect((await host.call(id, "secrets", "delete_everything", {})).isError).toBe(true);

		// The session ends: its one-time secret and its references go with it.
		const ref = (JSON.parse((result.content[0] as { text: string }).text) as { ref: string }).ref;
		host.release(ticket);
		expect(await service.store.reveal(ref.replace("secret://", ""))).toBeUndefined();
	});
});

describe("tunelo secrets", () => {
	it("lists without values and removes by id, logging the removal", async () => {
		const dir = tempDir("cli-");
		const held = await new SecretStore(dir).save("https://github.com", "GH_PASSWORD", VALUE);
		const lines: string[] = [];
		expect(await runSecrets("list", undefined, dir, (l) => lines.push(l))).toBe(0);
		expect(lines.join("\n")).toContain(`${held.id}  https://github.com  GH_PASSWORD`);
		expect(lines.join("\n")).not.toContain(VALUE);
		expect(await runSecrets("remove", held.id, dir, (l) => lines.push(l))).toBe(0);
		await expect(runSecrets("remove", held.id, dir, () => undefined)).rejects.toThrow(/no secret/);
		expect(readFileSync(join(dir, "audit.jsonl"), "utf8")).toContain("secret_remove");
		const empty: string[] = [];
		await runSecrets("list", undefined, dir, (l) => empty.push(l));
		expect(empty).toEqual(["No sign-in secrets are kept on this machine."]);
	});
});

describe("a session waiting for a secret", () => {
	it("shows as waiting for the user while the prompt is open", async () => {
		const { makeCore } = await import("./harness.ts");
		const { fakeProvider } = await import("./fake-provider.ts");
		const needs: string[] = [];
		const { core, work } = makeCore([fakeProvider()], { onNeedsInput: (t) => needs.push(t.id) });
		const thread = await core.create({ provider: "fake", model: "", dir: work, text: "hello", consent: { sensitive: false, projectSettings: false }, device: "phone" });
		core.setOutsidePrompts(thread.id, 1);
		expect(core.list().find((t) => t.id === thread.id)).toMatchObject({ state: ThreadState.WAITING, pending: 1 });
		expect(needs).toEqual([thread.id]);
		core.setOutsidePrompts(thread.id, 0);
		expect(core.list().find((t) => t.id === thread.id)?.state).not.toBe(ThreadState.WAITING);
	});
});

describe("the approval of a command that reads a secret", () => {
	it("carries no reason in words, and an allow for the session counts once", async () => {
		const results: unknown[] = [];
		const asked: { reason?: string }[] = [];
		const fake = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): Query => {
			const out = new Channel<SDKMessage>();
			const end = out.close.bind(out);
			void (async () => {
				for await (const _ of params.prompt) {
					const canUseTool = params.options.canUseTool;
					if (!canUseTool) throw new Error("no canUseTool");
					const signal = new AbortController().signal;
					const suggestions = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "curl:*" }], behavior: "allow", destination: "session" }];
					for (const command of ['curl -u "me:$TUNELO_SECRET_GH" https://api.github.com', "curl https://example.com"]) {
						results.push(
							await canUseTool("Bash", { command }, { signal, toolUseID: `t${results.length}`, decisionReason: "Hook asked", suggestions } as unknown as Parameters<typeof canUseTool>[2]),
						);
					}
					out.push({ type: "result", subtype: "success", is_error: false, duration_ms: 1 } as unknown as SDKMessage);
					end();
				}
			})();
			return Object.assign(out, {
				interrupt: async () => undefined,
				close: () => end(),
				accountInfo: async () => ({}),
				supportedCommands: async () => [],
				getContextUsage: async () => {
					throw new Error("n/a");
				},
				usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
					throw new Error("n/a");
				},
			}) as unknown as Query;
		};
		const provider = createClaudeProvider({ query: fake, findBinary: async () => "/bin/claude" });
		const s = await provider.start({
			policy: { dir: tempDir(), mcpServers: {}, projectSettings: false, isSensitive: () => false },
			askUser: async (req) => {
				asked.push(req as { reason?: string });
				return { decision: "allow-session" } as never;
			},
		});
		await s.send("go");
		const events: ProviderEvent[] = [];
		for await (const e of s.events) events.push(e);
		expect(asked[0]?.reason).toBeUndefined();
		expect(asked[1]?.reason).toBe("Hook asked");
		expect(results[0]).toEqual({ behavior: "allow", updatedInput: { command: 'curl -u "me:$TUNELO_SECRET_GH" https://api.github.com' } });
		expect(results[1]).toMatchObject({ behavior: "allow", updatedPermissions: [expect.objectContaining({ type: "addRules" })] });
		expect(events.filter((e) => e.type === "session-rules")).toHaveLength(1);
	});
});
