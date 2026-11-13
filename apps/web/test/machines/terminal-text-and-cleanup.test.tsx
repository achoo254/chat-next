// The terminal's text (font faces loaded before the first glyph, legibility
// options, a palette that reads on the dark surface, the size control kept in
// this browser), "Lưu trữ tất cả" in "Chưa phân loại" with "Hoàn tác", and the
// machines as cards on "Quản lý máy".
import { create } from "@bufbuild/protobuf";
import { ThreadSummarySchema, type Frame, type ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { AgentProjectsStore } from "../../src/machines/agent-projects-store.ts";
import type { LinkState, MachineLink } from "../../src/machines/link/machine-link.ts";
import type { Conn } from "../../src/machines/machine-status.ts";
import type { LooseFolder } from "../../src/machines/project-tree.ts";
import { LooseGroup, setFoldersArchived, UNDO_MS, type TreeContext } from "../../src/machines/project-tree-view.tsx";
import type { MachineView } from "../../src/machines/use-machines.ts";
import { rememberMode, rememberSessionMode, rowMode, sessionModeOf } from "../../src/machines/session-mode.tsx";
import {
	FONT_SAMPLE,
	FONT_SIZE_DEFAULT,
	FONT_SIZE_MAX,
	FONT_SIZE_MIN,
	MIN_CONTRAST,
	THEME,
	clampFontSize,
	fontKeyOf,
	fontSize,
	onFontSize,
	setFontSize,
	textOptions,
	waitForFont,
} from "../../src/terminal/terminal-font.ts";
import { FakeAgentProjects } from "../support/fake-agent-projects.ts";

const wrap = (node: ReactNode) => render(<I18nProvider>{node}</I18nProvider>);

afterEach(() => {
	window.localStorage.clear();
	vi.useRealTimers();
});

/** The WCAG contrast of two #rrggbb colours. */
function contrast(a: string, b: string): number {
	const lum = (hex: string) => {
		const [r, g, bl] = [1, 3, 5].map((i) => {
			const c = parseInt(hex.slice(i, i + 2), 16) / 255;
			return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
		});
		return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (bl ?? 0);
	};
	const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
	return ((x ?? 0) + 0.05) / ((y ?? 0) + 0.05);
}

describe("the terminal's text", () => {
	it("is set for legibility: 14 px, room for stacked tone marks, regular and semi-bold, a contrast floor", () => {
		expect(textOptions(FONT_SIZE_DEFAULT)).toMatchObject({ fontSize: 14, lineHeight: 1.35, letterSpacing: 0, fontWeight: 400, fontWeightBold: 600, minimumContrastRatio: 4.5 });
		expect(textOptions(16).fontFamily).toMatch(/^"JetBrains Mono", .*Menlo.*monospace$/);
		expect(MIN_CONTRAST).toBe(4.5);
	});

	it("every colour but black reads on the background at 4.5:1 or better, Claude Code's grey (bright black) included", () => {
		for (const [name, colour] of Object.entries(THEME)) {
			if (["background", "black", "cursorAccent", "selectionBackground"].includes(name)) continue;
			expect(contrast(colour, THEME.background), name).toBeGreaterThanOrEqual(4.5);
		}
		// xterm's own bright black does not.
		expect(contrast("#666666", THEME.background)).toBeLessThan(4.5);
	});

	it("loads the Vietnamese face and the bold one before the first glyph, at the size in use", async () => {
		const asked: [string, string | undefined][] = [];
		const load = vi.fn((font: string, text?: string) => {
			asked.push([font, text]);
			return Promise.resolve([]);
		});
		Object.defineProperty(document, "fonts", { configurable: true, value: { load } });
		await waitForFont(15, 1_000);
		expect(asked).toEqual([
			['400 15px "JetBrains Mono"', FONT_SAMPLE],
			['600 15px "JetBrains Mono"', FONT_SAMPLE],
		]);
		for (const letter of ["Ể", "Ộ", "Ữ", "đ", "Đ", "ư", "ơ"]) expect(FONT_SAMPLE).toContain(letter);
	});

	it("Ctrl (⌘ on a Mac) with + − 0 sizes the text; nothing else does", () => {
		const key = (k: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey", boolean>>, code = "") => ({ ctrlKey: false, metaKey: false, altKey: false, key: k, code, ...mods });
		expect(fontKeyOf(key("=", { ctrlKey: true }), false)).toBe("bigger");
		expect(fontKeyOf(key("+", { metaKey: true }), true)).toBe("bigger");
		expect(fontKeyOf(key("-", { ctrlKey: true }), false)).toBe("smaller");
		expect(fontKeyOf(key("0", { metaKey: true }), true)).toBe("reset");
		expect(fontKeyOf(key("", { ctrlKey: true }, "NumpadAdd"), false)).toBe("bigger");
		// Ctrl on a Mac, ⌘ elsewhere, Alt, or no modifier: not ours.
		expect(fontKeyOf(key("=", { ctrlKey: true }), true)).toBeNull();
		expect(fontKeyOf(key("=", { metaKey: true }), false)).toBeNull();
		expect(fontKeyOf(key("=", { ctrlKey: true, altKey: true }), false)).toBeNull();
		expect(fontKeyOf(key("=", {}), false)).toBeNull();
		expect(fontKeyOf(key("c", { ctrlKey: true }), false)).toBeNull();
	});

	it("the size is kept in this browser, between 11 and 20 px, and every terminal hears of a change", () => {
		expect(fontSize(FONT_SIZE_DEFAULT)).toBe(14);
		const heard: number[] = [];
		const stop = onFontSize((n) => heard.push(n));
		expect(setFontSize(17, 14)).toBe(17);
		expect(fontSize(14)).toBe(17);
		expect(setFontSize(99, 14)).toBe(FONT_SIZE_MAX);
		expect(setFontSize(3, 14)).toBe(FONT_SIZE_MIN);
		expect(setFontSize(null, 14)).toBe(14);
		expect(window.localStorage.getItem("terminal:font-size")).toBeNull();
		stop();
		setFontSize(12, 14);
		expect(heard).toEqual([17, 20, 11, 14]);
		expect(clampFontSize(15.6)).toBe(16);
	});

	it("keeps working when storage is refused", () => {
		const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new DOMException("denied", "SecurityError");
		});
		const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new DOMException("denied", "SecurityError");
		});
		expect(fontSize(13)).toBe(13);
		expect(setFontSize(16, 13)).toBe(16);
		get.mockRestore();
		set.mockRestore();
	});
});

type Req = Parameters<MachineLink["request"]>[0];
const ACK = { body: { case: "ack", value: {} } } as unknown as Frame;

function host(id: number, name: string) {
	const sent: Req[] = [];
	// The rows of an open group read each session's live activity too.
	const link = { request: (req: Req) => (sent.push(req), Promise.resolve(ACK)), activity: () => undefined, onActivity: () => () => undefined } as unknown as MachineLink;
	const state = { info: { agentVersion: "2.6.0", providers: [], home: "/w" }, threads: [], projects: null, threadInfo: new Map(), status: { kind: "open" } } as unknown as LinkState;
	const view = {
		entry: { ref: String(id), id, name, os: "darwin", arch: "arm64", agentVersion: "2.6.0", tunnelUrl: "", createdAt: 0, lastSeenAt: 0, claimed: true },
		link,
		state,
		conn: { kind: "on" } as Conn,
	} as unknown as MachineView;
	return { view, sent };
}

const session = (id: string, dir: string): ThreadSummary => create(ThreadSummarySchema, { id, dir, title: id, provider: "claude", updatedAt: 1n });
const folder = (machine: MachineView, dir: string, ids: string[]): LooseFolder => ({ machine, dir, threads: ids.map((id) => session(id, dir)), status: "idle" });
const archivedIds = (sent: Req[], archived: boolean) => sent.flatMap((r) => (r.case === "threadSetArchived" && r.value.archived === archived ? [r.value.threadId] : []));

async function looseCtx(machines: MachineView[]): Promise<TreeContext> {
	const store = new AgentProjectsStore(new FakeAgentProjects().api());
	await store.refresh();
	return { store, projects: [], machines, now: Date.now(), seen: new Map(), current: null };
}

describe("a session row's glyph", () => {
	it("a session held by a terminal while its AI waits at the prompt: a calm terminal glyph and 'Mở trong terminal', never a spinner", async () => {
		const mac = host(1, "Mac");
		const held = create(ThreadSummarySchema, { id: "h1", dir: "/tmp/a", title: "Phiên mới", provider: "claude", updatedAt: 1n, terminalSession: 3 });
		const working = create(ThreadSummarySchema, { id: "w1", dir: "/tmp/a", title: "Đang sửa", provider: "claude", updatedAt: 1n, terminalSession: 4, busyElsewhere: true });
		const { container } = wrap(<LooseGroup folders={[{ machine: mac.view, dir: "/tmp/a", threads: [held, working], status: "running" }]} ctx={await looseCtx([mac.view])} open onToggle={() => undefined} />);
		const rows = [...container.querySelectorAll(".mx-srow")];
		const heldRow = rows.find((r) => r.textContent?.includes("Phiên mới"));
		const workingRow = rows.find((r) => r.textContent?.includes("Đang sửa"));
		expect(heldRow?.querySelector(".mx-glyph")?.className).toBe("mx-glyph open");
		expect(heldRow?.querySelector(".mx-glyph")?.getAttribute("aria-label")).toBe("claude · Mở trong terminal, đang chờ lệnh");
		expect(within(heldRow as HTMLElement).getByRole("img", { name: "Mở trong terminal" })).toBeTruthy();
		// A turn running in the terminal: the spinner, and it says so.
		expect(workingRow?.querySelector(".mx-glyph")?.className).toBe("mx-glyph running");
		expect(within(workingRow as HTMLElement).getByRole("img", { name: "Đang chạy trong terminal" })).toBeTruthy();
	});
});

describe("a session row's mode icon", () => {
	it("a live hold wins (terminal, or open as a chat here); else the mode the session was last opened in; else the machine's", () => {
		const base = { id: "s1", terminalSession: 0, open: false };
		expect(rowMode("1", { ...base, terminalSession: 2 })).toBe("terminal");
		expect(rowMode("1", { ...base, open: true })).toBe("chat");
		// Never opened here: the machine's last mode.
		expect(rowMode("1", base)).toBe("chat");
		rememberMode("1", "terminal");
		expect(rowMode("1", base)).toBe("terminal");
		// Opened in a mode: that one, whatever the machine's last.
		rememberSessionMode("1", "s1", "chat");
		expect(sessionModeOf("1", "s1")).toBe("chat");
		expect(rowMode("1", base)).toBe("chat");
		// A live hold still wins over what was remembered.
		expect(rowMode("1", { ...base, terminalSession: 5 })).toBe("terminal");
	});

	it("every row shows its mode: a chat bubble 'Trò chuyện' or a terminal 'Terminal' (a terminal hold says how)", async () => {
		rememberSessionMode("1", "c1", "chat");
		rememberSessionMode("1", "t1", "terminal");
		const mac = host(1, "Mac");
		const row = (id: string, extra: { open?: boolean; terminalSession?: number } = {}) => create(ThreadSummarySchema, { id, dir: "/tmp/a", title: id, provider: "claude", updatedAt: 1n, ...extra });
		// A folder lists its three newest sessions: two folders hold the four cases.
		const folders: LooseFolder[] = [
			{ machine: mac.view, dir: "/tmp/a", threads: [row("c1"), row("t1"), row("hi", { open: true })], status: "idle" },
			{ machine: mac.view, dir: "/tmp/b", threads: [row("held", { terminalSession: 3 })], status: "open" },
		];
		const { container } = wrap(<LooseGroup folders={folders} ctx={await looseCtx([mac.view])} open onToggle={() => undefined} />);
		const modeOf = (title: string) => {
			const r = [...container.querySelectorAll(".mx-srow")].find((x) => x.querySelector(".name")?.textContent === title);
			const icon = r?.querySelector(".mx-row-mode");
			return [icon?.getAttribute("data-mode"), icon?.getAttribute("aria-label")];
		};
		expect(modeOf("c1")).toEqual(["chat", "Trò chuyện"]);
		expect(modeOf("t1")).toEqual(["terminal", "Terminal"]);
		expect(modeOf("hi")).toEqual(["chat", "Trò chuyện"]);
		expect(modeOf("held")).toEqual(["terminal", "Mở trong terminal"]);
		// The AI icon, which carries the state, stays beside it, unchanged.
		expect(container.querySelectorAll(".mx-srow .mx-glyph")).toHaveLength(4);
	});
});

describe("Chưa phân loại: archive all, then undo", () => {
	it("says what the group holds, and a folder's menu archives that folder's sessions only, with Hoàn tác", async () => {
		const mac = host(1, "Mac");
		const folders = [folder(mac.view, "/tmp/a", ["a1", "a2"]), folder(mac.view, "/tmp/b", ["b1"])];
		wrap(<LooseGroup folders={folders} ctx={await looseCtx([mac.view])} open onToggle={() => undefined} />);
		expect(screen.getByText("Phiên tìm thấy trên máy nhưng chưa thuộc dự án nào.")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Tuỳ chọn cho workspace a" }));
		await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Lưu trữ tất cả phiên" }));
		await waitFor(() => expect(archivedIds(mac.sent, true).sort()).toEqual(["a1", "a2"]));
		// No blocking question: it only hides them, and says how to bring them back.
		expect(screen.queryByRole("dialog")).toBeNull();
		const undo = await screen.findByRole("status");
		expect(undo.textContent).toContain("Đã lưu trữ 2 phiên");
		await userEvent.click(within(undo).getByRole("button", { name: "Hoàn tác" }));
		await waitFor(() => expect(archivedIds(mac.sent, false).sort()).toEqual(["a1", "a2"]));
		expect(screen.queryByText(/Đã lưu trữ 2 phiên/)).toBeNull();
	});

	it("the group's menu archives every folder's sessions on every machine at once, with one Hoàn tác", async () => {
		const mac = host(1, "Mac");
		const pc = host(2, "PC");
		const folders = [folder(mac.view, "/tmp/a", ["a1"]), folder(pc.view, "/srv/b", ["b1", "b2"])];
		wrap(<LooseGroup folders={folders} ctx={await looseCtx([mac.view, pc.view])} open={false} onToggle={() => undefined} />);
		await userEvent.click(screen.getByRole("button", { name: "Tuỳ chọn cho Chưa phân loại" }));
		await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Lưu trữ tất cả (3)" }));
		await waitFor(() => expect([...archivedIds(mac.sent, true), ...archivedIds(pc.sent, true)].sort()).toEqual(["a1", "b1", "b2"]));
		await userEvent.click(await screen.findByRole("button", { name: "Hoàn tác" }));
		await waitFor(() => expect([...archivedIds(mac.sent, false), ...archivedIds(pc.sent, false)].sort()).toEqual(["a1", "b1", "b2"]));
	});

	it("Hoàn tác goes away by itself after a while", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const mac = host(1, "Mac");
		wrap(<LooseGroup folders={[folder(mac.view, "/tmp/a", ["a1"])]} ctx={await looseCtx([mac.view])} open onToggle={() => undefined} />);
		await setFoldersArchived([], true);
		await userEvent.click(screen.getByRole("button", { name: "Tuỳ chọn cho workspace a" }));
		await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Lưu trữ tất cả phiên" }));
		await screen.findByRole("button", { name: "Hoàn tác" });
		vi.advanceTimersByTime(UNDO_MS + 50);
		await waitFor(() => expect(screen.queryByRole("button", { name: "Hoàn tác" })).toBeNull());
	});
});
