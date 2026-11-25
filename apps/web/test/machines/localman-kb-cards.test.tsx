// The cards a session shows for Localman and the Knowledge Base: a request
// the AI sent (localman_send_request) as a result card with its status
// colored, secret headers masked, the body folded and a short copy for the
// chat's composer; the documents a kb tool answered with as source chips;
// and the approval card of a note kb_save_note saves. Anything not
// recognised keeps the generic rendering.
import { create } from "@bufbuild/protobuf";
import { ApprovalItemSchema, ApprovalWriteSchema, PromptState, ToolKind, type ApprovalWrite, type ToolCallItem, type ToolResultItem } from "@achoo254/chat-proto/remote/remote";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { ApprovalCard, headerLine, writeWords } from "../../src/machines/cards/approval.tsx";
import { kbSources } from "../../src/machines/cards/kb-sources.tsx";
import { BODY_LINES, parseLocalmanResult, shortResult, shownHeader, statusClass } from "../../src/machines/cards/localman-result.tsx";
import { ToolRunCard } from "../../src/machines/cards/tool-run.tsx";
import { UseTextContext, type UseText } from "../../src/machines/cards/use-text-context.ts";
import { enMachines } from "../../src/machines/copy-en.ts";
import { viMachines } from "../../src/machines/copy-vi.ts";
import { zhCNMachines } from "../../src/machines/copy-zh-CN.ts";
import type { ToolRun } from "../../src/machines/transcript/tool-fold.ts";

const INPUT = JSON.stringify({ method: "get", url: "https://api.example.com/health", headers: [{ name: "Authorization", value: "Bearer abc" }] });
const BODY = ["{", '  "ok": true,', '  "db": "up",', '  "cache": "up",', '  "queue": "up",', '  "version": "1.2.3",', '  "uptime": 3600', "}"].join("\n");
const RESPONSE = {
	status: 200,
	statusText: "OK",
	headers: [
		{ name: "Content-Type", value: "application/json" },
		{ name: "Set-Cookie", value: "sid=s3cret" },
		{ name: "X-Api-Key", value: "k-123" },
	],
	body: BODY,
	bodyEncoding: "utf8",
	size: 120,
	timings: { dns: 1, connect: 2, tls: 3, ttfb: 40, total: 87.4 },
	finalUrl: "https://api.example.com/health",
	truncated: false,
};

const run = (name: string, input: string, output: string, ok = true): ToolRun => ({
	id: "r1",
	at: Date.now(),
	call: { toolId: "1", kind: ToolKind.MCP, name, summary: "", input, sensitive: false } as unknown as ToolCallItem,
	result: { toolId: "1", ok, output, truncated: false } as unknown as ToolResultItem,
	subagent: null,
	resultId: "result:r1",
	approval: null,
	subagentFiles: [],
});

function card(runs: ToolRun, useText: UseText | null = null) {
	return render(
		<I18nProvider>
			<UseTextContext value={useText}>
				<ToolRunCard runs={[runs]} full={new Map()} onFetchFull={() => Promise.resolve()} live={false} />
			</UseTextContext>
		</I18nProvider>,
	);
}

describe("the result of a Localman request", () => {
	it("reads the response bare or inside an MCP result, and nothing else", () => {
		const bare = parseLocalmanResult(INPUT, JSON.stringify(RESPONSE));
		expect(bare).toMatchObject({ method: "GET", url: "https://api.example.com/health", status: 200, ms: 87, binary: false, historyUrl: "" });
		expect(parseLocalmanResult(INPUT, JSON.stringify({ content: [{ type: "text", text: JSON.stringify(RESPONSE) }] }))?.status).toBe(200);
		expect(parseLocalmanResult(INPUT, JSON.stringify({ structuredContent: { ...RESPONSE, status: 404 } }))?.status).toBe(404);
		expect(parseLocalmanResult(INPUT, JSON.stringify({ ...RESPONSE, historyUrl: "https://localman.example/h/9" }))?.historyUrl).toBe("https://localman.example/h/9");
		expect(parseLocalmanResult(INPUT, JSON.stringify({ ...RESPONSE, historyUrl: "javascript:alert(1)" }))?.historyUrl).toBe("");
		expect(parseLocalmanResult(INPUT, "Error: 403 PROXY_TARGET_BLOCKED")).toBeNull();
		expect(parseLocalmanResult(INPUT, JSON.stringify({ error: "nope" }))).toBeNull();
	});

	it("colors the status by class and masks secret headers", () => {
		expect([200, 204, 301, 404, 429, 500, 0].map(statusClass)).toEqual(["ok", "ok", "redirect", "client", "client", "server", "server"]);
		expect(shownHeader("Authorization", "Bearer x")).toBe("••••••");
		expect(shownHeader("set-cookie", "a=b")).toBe("••••••");
		expect(shownHeader("X-Api-Key", "k")).toBe("••••••");
		expect(shownHeader("x-auth-token", "t")).toBe("••••••");
		expect(shownHeader("Content-Type", "application/json")).toBe("application/json");
	});

	it("puts method, URL, status, time and five body lines into the short copy", () => {
		const result = parseLocalmanResult(INPUT, JSON.stringify(RESPONSE));
		if (result === null) throw new Error("no result");
		expect(shortResult(result)).toBe(["GET https://api.example.com/health → 200 (87 ms)", ...BODY.split("\n").slice(0, 5)].join("\n"));
		expect(shortResult({ ...result, binary: true })).toBe("GET https://api.example.com/health → 200 (87 ms)");
	});

	it("shows the card under the tool row: status, masked headers, the body folded until asked, the short copy into the composer", async () => {
		const taken: [string, boolean | undefined][] = [];
		const useText: UseText = (text, plain) => {
			taken.push([text, plain]);
			return Promise.resolve(true);
		};
		card(run("mcp__tunelo__localman_send_request", INPUT, JSON.stringify({ ...RESPONSE, status: 503, statusText: "Service Unavailable" })), useText);
		const result = screen.getByRole("region", { name: "Kết quả request Localman" });
		expect(within(result).getByText("503 Service Unavailable").getAttribute("data-status-class")).toBe("server");
		expect(within(result).getByText("87 ms")).toBeTruthy();
		// No "Kết quả" of the generic row: the card stands for it.
		expect(screen.queryByText("Kết quả")).toBeNull();
		expect(within(result).queryByText("sid=s3cret")).toBeNull();
		expect(within(result).queryByText("k-123")).toBeNull();
		expect(within(result).getAllByText("••••••")).toHaveLength(2);
		const body = result.querySelector("pre");
		expect(body?.textContent?.split("\n")).toHaveLength(BODY_LINES);
		await userEvent.click(within(result).getByRole("button", { name: "Xem thêm" }));
		expect(body?.textContent).toBe(BODY);
		// Without a history page from the result, no «Mở trong Localman».
		expect(within(result).queryByRole("link", { name: "Mở trong Localman" })).toBeNull();
		await userEvent.click(within(result).getByRole("button", { name: "Chép kết quả gọn" }));
		expect(taken).toEqual([[expect.stringMatching(/^GET https:\/\/api\.example\.com\/health → 503 \(87 ms\)\n\{/), true]]);
	});

	it("links the history page when the result names one, and offers no copy outside the AI panel", () => {
		card(run("localman_send_request", INPUT, JSON.stringify({ ...RESPONSE, historyUrl: "https://localman.example/h/9" })));
		const link = screen.getByRole("link", { name: "Mở trong Localman" });
		expect(link.getAttribute("href")).toBe("https://localman.example/h/9");
		expect(link.getAttribute("rel")).toBe("noopener noreferrer");
		expect(screen.queryByRole("button", { name: "Chép kết quả gọn" })).toBeNull();
	});

	it("keeps the generic output for a result that is not the request's JSON", () => {
		card(run("mcp__tunelo__localman_send_request", INPUT, "403 PROXY_TARGET_BLOCKED: open a tunnel"));
		expect(screen.queryByRole("region", { name: "Kết quả request Localman" })).toBeNull();
		expect(screen.getByText("Kết quả")).toBeTruthy();
		expect(screen.getByText("403 PROXY_TARGET_BLOCKED: open a tunnel")).toBeTruthy();
	});
});

describe("Knowledge Base sources", () => {
	const ORIGIN = "https://kb.hoandat.com";

	it("takes the documents with a Knowledge Base link, once each, from every shape", () => {
		expect(kbSources(JSON.stringify({ results: [{ title: "Deploy", url: `${ORIGIN}/d/1` }, { title: "Lạ", url: "https://evil.example/d/2" }, { title: "Http", url: "http://kb.hoandat.com/d/3" }] }), ORIGIN)).toEqual([
			{ title: "Deploy", url: `${ORIGIN}/d/1` },
		]);
		expect(kbSources(JSON.stringify({ document: { title: "Một", url: `${ORIGIN}/d/1` } }), ORIGIN)).toEqual([{ title: "Một", url: `${ORIGIN}/d/1` }]);
		expect(kbSources(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ documents: [{ url: `${ORIGIN}/d/4` }, { title: "Lặp", url: `${ORIGIN}/d/4` }] }) }] }), ORIGIN)).toEqual([
			{ title: `${ORIGIN}/d/4`, url: `${ORIGIN}/d/4` },
		]);
		expect(kbSources("not json", ORIGIN)).toEqual([]);
		expect(kbSources(JSON.stringify({ results: "x", document: 3 }), ORIGIN)).toEqual([]);
		expect(kbSources(JSON.stringify([1, 2]), ORIGIN)).toEqual([]);
	});

	it("shows them as chips under a kb tool's row, opening in a new tab", () => {
		card(run("mcp__tunelo__kb_search", "{}", JSON.stringify({ results: [{ title: "Deploy .65", url: "https://kb.hoandat.com/d/1" }, { title: "Ngoài", url: "https://other.example/x" }] })));
		const list = screen.getByRole("list", { name: "Nguồn từ Knowledge Base" });
		const links = within(list).getAllByRole("link");
		expect(links).toHaveLength(1);
		expect(links[0]?.textContent).toContain("Deploy .65");
		expect(links[0]?.getAttribute("target")).toBe("_blank");
		expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer");
	});

	it("shows no chips for another tool or an answer without documents", () => {
		card(run("mcp__tunelo__kb_list_spaces", "{}", JSON.stringify({ results: [{ title: "A", url: "https://kb.hoandat.com/s/a" }] })));
		expect(screen.queryByRole("list", { name: "Nguồn từ Knowledge Base" })).toBeNull();
	});
});

describe("the approval card of a Knowledge Base note", () => {
	const note = (fields: Partial<Omit<ApprovalWrite, "$typeName">> = {}): ApprovalWrite =>
		create(ApprovalWriteSchema, { tool: "kb_save_note", title: "Deploy .65", space: "", visibility: "private", text: "Các bước deploy", textLength: 15, ...fields });

	it("says what is saved where, in every language", () => {
		expect(writeWords(viMachines, note(), "").summary).toBe("Lưu ghi chú riêng tư «Deploy .65» vào Space riêng của bạn");
		expect(writeWords(enMachines, note(), "").summary).toBe("Save a private note «Deploy .65» to Your private Space");
		expect(writeWords(zhCNMachines, note(), "").summary).toBe("将私人笔记「Deploy .65」保存到你的私人空间");
		expect(writeWords(viMachines, note({ space: "ha-tang" }), "").summary).toBe("Lưu ghi chú riêng tư «Deploy .65» vào ha-tang");
		expect(writeWords(enMachines, note({ space: "ha-tang", visibility: "" }), "").summary).toBe("Save a note «Deploy .65» to ha-tang");
	});

	it("shows title, Space, who reads it and the start of the text with its full length", () => {
		render(
			<I18nProvider>
				<ApprovalCard
					approval={create(ApprovalItemSchema, { toolId: "t", kind: ToolKind.MCP, name: "mcp__tunelo__kb_save_note", input: "{}", summary: "Save note", reason: "It acts as you", state: PromptState.PENDING, write: note({ text: "Các bước", textLength: 2400 }) })}
					ai="Claude"
					sessionAllow={false}
					onDecide={async () => undefined}
				/>
			</I18nProvider>,
		);
		expect(screen.getByText("Deploy .65")).toBeTruthy();
		expect(screen.getByText("Space riêng của bạn")).toBeTruthy();
		expect(screen.getByText("Riêng tư — chỉ bạn đọc được")).toBeTruthy();
		expect(screen.getByText("Các bước… (2400 ký tự)")).toBeTruthy();
		expect(screen.queryByText("Save note")).toBeNull();
	});

	it("keeps an older machine's own line when it does not describe the note", () => {
		const old = create(ApprovalWriteSchema, { tool: "kb_save_note" });
		expect(writeWords(viMachines, old, "").summary).toBeNull();
		render(
			<I18nProvider>
				<ApprovalCard
					approval={create(ApprovalItemSchema, { toolId: "t", kind: ToolKind.MCP, name: "mcp__tunelo__kb_save_note", input: "{}", summary: "Save note «x»", reason: "It acts as you", state: PromptState.PENDING, write: old })}
					ai="Claude"
					sessionAllow={false}
					onDecide={async () => undefined}
				/>
			</I18nProvider>,
		);
		expect(screen.getByText("Save note «x»")).toBeTruthy();
		expect(screen.queryByText("Tiêu đề")).toBeNull();
	});
});

describe("the approval card of a Localman request", () => {
	const headers = [
		{ name: "Authorization", value: "", masked: true },
		{ name: "Content-Type", value: "application/json", masked: false },
	];
	const sendIt = (fields: Partial<Omit<ApprovalWrite, "$typeName">> = {}): ApprovalWrite =>
		create(ApprovalWriteSchema, { tool: "localman_send_request", method: "POST", url: "http://localhost:3000/api/items", headers, text: '{"name":"a"}', textLength: 12, reachesLocal: true, ...fields });
	const saveIt = (fields: Partial<Omit<ApprovalWrite, "$typeName">> = {}): ApprovalWrite =>
		create(ApprovalWriteSchema, { tool: "localman_create_collection_node", method: "GET", url: "https://api.example.com/health", title: "Health", collectionId: "c_9", collectionName: "Cloudpanel", headers, ...fields });
	const cardOf = (write: ApprovalWrite, summary = "POST http://localhost:3000/api/items") =>
		render(
			<I18nProvider>
				<ApprovalCard
					approval={create(ApprovalItemSchema, { toolId: "t", kind: ToolKind.MCP, name: `mcp__tunelo__${write.tool}`, input: "{}", summary, reason: "It acts as you", state: PromptState.PENDING, write })}
					ai="Claude"
					sessionAllow={false}
					onDecide={async () => undefined}
				/>
			</I18nProvider>,
		);

	it("lists headers with credentials masked", () => {
		expect(headers.map(headerLine)).toEqual(["Authorization: ••••", "Content-Type: application/json"]);
	});

	it("says where a saved request goes, in every language, the collection by name or else by id", () => {
		expect(writeWords(viMachines, saveIt(), "").summary).toBe("Lưu request «Health» vào collection «Cloudpanel»: GET https://api.example.com/health");
		expect(writeWords(enMachines, saveIt(), "").summary).toBe("Save the request «Health» to «Cloudpanel»: GET https://api.example.com/health");
		expect(writeWords(zhCNMachines, saveIt(), "").summary).toBe("将请求「Health」保存到「Cloudpanel」：GET https://api.example.com/health");
		expect(writeWords(viMachines, saveIt({ collectionName: "" }), "").summary).toBe("Lưu request «Health» vào collection «c_9»: GET https://api.example.com/health");
		// An older machine names no collection: its own line stays.
		expect(writeWords(viMachines, create(ApprovalWriteSchema, { tool: "localman_create_collection_node" }), "").summary).toBeNull();
		for (const t of [viMachines, enMachines, zhCNMachines]) expect(writeWords(t, sendIt(), "").summary).toBe("POST http://localhost:3000/api/items");
		expect([viMachines, enMachines, zhCNMachines].map((t) => t.approval.write.lmLocal)).toEqual(["Chạy qua máy của bạn", "Runs through your machine", "通过你的电脑发送"]);
	});

	it("shows a request sent through the user's machine with its headers masked and the start of its body", () => {
		cardOf(sendIt({ text: '{"name":"a"', textLength: 900 }));
		expect(screen.getByText("Chạy qua máy của bạn")).toBeTruthy();
		expect(screen.getByText("Authorization: ••••")).toBeTruthy();
		expect(screen.getByText("Content-Type: application/json")).toBeTruthy();
		expect(screen.getByText('{"name":"a"… (900 ký tự)')).toBeTruthy();
		expect(screen.getByText("POST http://localhost:3000/api/items")).toBeTruthy();
	});

	it("shows no badge for a request to the internet", () => {
		cardOf(sendIt({ reachesLocal: false, url: "https://api.example.com/items" }), "POST https://api.example.com/items");
		expect(screen.queryByText("Chạy qua máy của bạn")).toBeNull();
		expect(screen.getByText("Authorization: ••••")).toBeTruthy();
	});

	it("shows the collection and the new request's name of a save", () => {
		cardOf(saveIt(), "Save request");
		expect(screen.getByText("Lưu request «Health» vào collection «Cloudpanel»: GET https://api.example.com/health")).toBeTruthy();
		expect(screen.getByText("Cloudpanel")).toBeTruthy();
		expect(screen.getByText("Health")).toBeTruthy();
		expect(screen.getByText("Authorization: ••••")).toBeTruthy();
		expect(screen.queryByText("Save request")).toBeNull();
	});

	it("keeps an older machine's card as it was", () => {
		cardOf(create(ApprovalWriteSchema, { tool: "localman_send_request", method: "GET", url: "https://x.example" }), "GET https://x.example");
		expect(screen.getByText("GET https://x.example")).toBeTruthy();
		expect(screen.queryByText("Header")).toBeNull();
		expect(screen.queryByText("Chạy qua máy của bạn")).toBeNull();
	});
});
