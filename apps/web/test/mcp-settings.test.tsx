// Settings > Kết nối AI (MCP): the endpoint address, the snippet of each AI
// tool, the scopes an AI tool can ask for and where to revoke them (ADR 0012).
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { brand } from "../src/brand.ts";
import { mcpSnippet } from "../src/messaging/settings/mcp-settings.tsx";
import { matchRoute } from "../src/router.tsx";
import { seedDemo } from "./support/demo-data.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const LONG = { timeout: 8000 };

describe("MCP settings", () => {
	it("routes the tab", () => {
		expect(matchRoute("/settings/mcp")).toEqual({ name: "settings", tab: "mcp" });
	});

	it("builds the snippet of each AI tool", () => {
		const url = "https://chat.example.test/mcp";
		expect(mcpSnippet("claude", url)).toBe("claude mcp add --transport http chat https://chat.example.test/mcp");
		expect(JSON.parse(mcpSnippet("cursor", url))).toEqual({ mcpServers: { chat: { url } } });
		expect(JSON.parse(mcpSnippet("vscode", url))).toEqual({ servers: { chat: { type: "http", url } } });
	});

	it("shows the address, copies the picked tool's snippet, lists the scopes and links to the IdP account", async () => {
		const written: string[] = [];
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (text: string) => Promise.resolve(void written.push(text)) } });
		const demo = seedDemo();
		renderMessaging(demo.fixture, "/settings/mcp");
		expect(await screen.findByRole("heading", { level: 1, name: "Kết nối AI (MCP)" }, LONG)).toBeTruthy();
		const url = `${window.location.origin}/mcp`;
		expect(screen.getByRole("link", { name: /Kết nối AI \(MCP\)/ }).getAttribute("aria-current")).toBe("page");

		await userEvent.click(screen.getByRole("button", { name: "Sao chép địa chỉ MCP" }));
		await waitFor(() => expect(written).toEqual([url]));

		const howTo = screen.getByRole("heading", { level: 2, name: "Thêm vào công cụ AI" }).closest(".card") as HTMLElement;
		expect(within(howTo).getByLabelText("Thêm vào công cụ AI").textContent).toBe(`claude mcp add --transport http chat ${url}`);
		await userEvent.click(within(within(howTo).getByRole("group", { name: "Công cụ AI" })).getByRole("button", { name: "Cursor" }));
		await userEvent.click(within(howTo).getByRole("button", { name: "Sao chép" }));
		await waitFor(() => expect(written[1]).toBe(mcpSnippet("cursor", url)));

		const scopes = screen.getByRole("heading", { level: 2, name: "Quyền công cụ AI có thể xin" }).closest(".card") as HTMLElement;
		for (const scope of ["chat:read", "chat:write", "bots:read", "bots:write", "bots:admin"]) expect(within(scopes).getByText(scope)).toBeTruthy();
		expect(within(scopes).getByText("Nhạy cảm")).toBeTruthy();

		expect(screen.getByRole("link", { name: /Quản lý/ }).getAttribute("href")).toBe(brand.accountUrl);
	});
});
