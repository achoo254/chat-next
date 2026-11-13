// The remote chat's widgets: tool rows (one call alone, two or more grouped,
// the answered prompt folded in), the status bar (what shows, what is left
// out, reset countdowns, the permission mode), the "/" picker of the
// composer.
import { create } from "@bufbuild/protobuf";
import {
	Decision,
	PromptState,
	SlashCommandSchema,
	ThreadInfoSchema,
	ToolKind,
	type ApprovalItem,
	type ToolCallItem,
	type ToolResultItem,
} from "@achoo254/chat-proto/remote/remote";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { ToolRunCard } from "../../src/machines/cards/tool-run.tsx";
import { Composer } from "../../src/machines/composer.tsx";
import { filterCommands, flatCommands } from "../../src/machines/slash-commands.ts";
import { commandToken } from "../../src/components/plain-text-box.tsx";
import type { MachineLink } from "../../src/machines/link/machine-link.ts";
import { StatusBar } from "../../src/machines/status-bar.tsx";
import { permissionMode, resetIn, usageOf } from "../../src/machines/status-line.ts";
import type { ToolRun } from "../../src/machines/transcript/tool-fold.ts";
import { boxValue } from "../support/plain-text-box.ts";

const wrap = (node: ReactNode) => render(<I18nProvider>{node}</I18nProvider>);

/** A link that records requests and answers each one at once. */
const fakeLink = () => {
	const sent: unknown[] = [];
	const link = { request: (body: unknown) => (sent.push(body), Promise.resolve({})) } as unknown as MachineLink;
	return { link, sent };
};
const live = { link: fakeLink().link, threadId: "t", online: true };

const call = (toolId: string, summary: string): ToolCallItem =>
	({ toolId, kind: ToolKind.SHELL, name: "Bash", summary, input: "", sensitive: false }) as unknown as ToolCallItem;
const ok = { toolId: "", ok: true, output: "done", truncated: false } as unknown as ToolResultItem;
const answered = (decision: Decision): ApprovalItem => ({ toolId: "1", state: PromptState.ANSWERED, decision }) as unknown as ApprovalItem;
const run = (id: string, summary: string, extra: Partial<ToolRun> = {}): ToolRun => ({
	id,
	at: Date.now(),
	call: call(id, summary),
	result: ok,
	subagent: null,
	resultId: `result:${id}`,
	approval: null,
	subagentFiles: [],
	...extra,
});

describe("tool rows", () => {
	it("shows one call as a row without a group header, with its answered prompt inside", () => {
		const long = `pnpm exec vitest run ${"a/very/long/path/".repeat(30)}`;
		wrap(<ToolRunCard runs={[run("1", long, { approval: answered(Decision.ALLOW_SESSION) })]} full={new Map()} onFetchFull={() => Promise.resolve()} live={false} />);
		expect(screen.queryByText(/Đã chạy/)).toBeNull();
		const row = screen.getByRole("listitem");
		expect(within(row).getByText("Đã cho phép cả phiên")).toBeTruthy();
		// The command wraps and is clamped to three lines by CSS until "Xem thêm".
		const command = row.querySelector(".mx-run-cmd");
		expect(command?.classList.contains("clamp")).toBe(true);
		expect(within(row).getByText("Kết quả")).toBeTruthy();
	});

	it("shows how long a running call has run and the timeout it asked for", () => {
		const slow = run("1", "sleep 400", { result: null, resultId: null, at: Date.now() - 65_000 });
		const withTimeout = { ...slow, call: { ...call("1", "sleep 400"), input: '{"command":"sleep 400","timeout":400000}' } as ToolCallItem };
		wrap(<ToolRunCard runs={[withTimeout]} full={new Map()} onFetchFull={() => Promise.resolve()} live />);
		expect(screen.getByText(/Chạy được 1 phút 5 giây · timeout 6 phút 40 giây/)).toBeTruthy();
	});

	it("shows only the running time when the call gave no timeout, and nothing once it ended", () => {
		const slow = run("1", "make", { result: null, resultId: null, at: Date.now() - 12_000 });
		const { unmount } = wrap(<ToolRunCard runs={[slow]} full={new Map()} onFetchFull={() => Promise.resolve()} live />);
		expect(screen.getByText(/Chạy được 12 giây$/)).toBeTruthy();
		unmount();
		wrap(<ToolRunCard runs={[run("2", "make")]} full={new Map()} onFetchFull={() => Promise.resolve()} live />);
		expect(screen.queryByText(/Chạy được/)).toBeNull();
	});

	it("groups two or more calls under 'Đã chạy N tool'", () => {
		wrap(<ToolRunCard runs={[run("1", "ls"), run("2", "pwd")]} full={new Map()} onFetchFull={() => Promise.resolve()} live={false} />);
		expect(screen.getByText("Đã chạy 2 tool")).toBeTruthy();
		expect(screen.getAllByRole("listitem", { hidden: true })).toHaveLength(2);
	});
});

describe("status bar", () => {
	const NOW = Date.UTC(2026, 10, 8, 7, 0, 0);

	it("counts down to a reset in days, hours and minutes, and leaves unknown resets out", () => {
		expect(resetIn(NOW + (4 * 60 + 31) * 60_000, NOW)).toEqual({ days: 0, hours: 4, minutes: 31 });
		expect(resetIn(BigInt(NOW + 2 * 86_400_000 + 3_600_000), NOW)).toEqual({ days: 2, hours: 1, minutes: 0 });
		expect(resetIn(NOW + 10_000, NOW)).toEqual({ days: 0, hours: 0, minutes: 1 });
		expect(resetIn(0n, NOW)).toBeNull();
		expect(resetIn(NOW - 1, NOW)).toBeNull();
		expect(usageOf(undefined, NOW)).toBeNull();
		expect(usageOf({ utilization: 140, resetsAt: 0n } as never, NOW)).toMatchObject({ pct: 100, left: null });
	});

	it("knows Claude's permission modes and keeps others as they are", () => {
		expect(permissionMode("acceptEdits")).toBe("acceptEdits");
		expect(permissionMode("bypassPermissions")).toBe("bypassPermissions");
		expect(permissionMode("dontAsk")).toBeNull();
	});

	it("keeps model and mode in the line, usage only near its limit, the rest labelled in Chi tiết", async () => {
		vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
		try {
			const user = userEvent.setup();
			const info = create(ThreadInfoSchema, {
				threadId: "t",
				permissionMode: "bypassPermissions",
				gitBranch: "main",
				linesAdded: 22,
				linesRemoved: 27,
				effort: "xhigh",
				account: { email: "me@example.com", organization: "Acme", plan: "max" },
				rateLimits: {
					fiveHour: { utilization: 4, resetsAt: BigInt(NOW + (4 * 60 + 31) * 60_000) },
					sevenDay: { utilization: 80, resetsAt: BigInt(NOW + 2 * 86_400_000 + 60_000) },
				},
			});
			wrap(<StatusBar ai="Claude Code" dir={"D:\\CONG VIEC\\chat-next"} machine={null} provider="claude" model="" context={0.34} info={info} {...live} />);
			const bar = screen.getByRole("group", { name: "Trạng thái phiên" });
			expect(within(bar).getByText("mặc định")).toBeTruthy();
			expect(within(bar).getByText("Bỏ qua quyền").closest(".mx-mode")?.classList.contains("warn")).toBe(true);
			// Each usage window only once it nears its limit (80%), as a warning; both are always in Chi tiết.
			expect(within(bar).queryByText("5 giờ")).toBeNull();
			expect(within(bar).getByText("7 ngày").closest(".mx-usage")?.classList.contains("warn")).toBe(true);
			expect(within(bar).queryByText("main")).toBeNull();
			await user.click(within(bar).getByRole("button", { name: "Chi tiết" }));
			const details = screen.getByRole("dialog", { name: "Chi tiết phiên" });
			expect(within(details).getByText("D:\\CONG VIEC\\chat-next")).toBeTruthy();
			expect(within(details).getByText("main")).toBeTruthy();
			expect(within(details).getByText("Rất cao")).toBeTruthy();
			expect(within(details).getByText("đã dùng 34%")).toBeTruthy();
			expect(within(details).getByText("me@example.com · Max")).toBeTruthy();
			expect(within(details).getByText("4% · đặt lại sau 4h31m")).toBeTruthy();
			expect(within(details).getByText("80% · đặt lại sau 2d")).toBeTruthy();
			expect(within(details).getByText("+22")).toBeTruthy();
		} finally {
			vi.useRealTimers();
		}
	});

	it("leaves out what is not known yet", () => {
		wrap(<StatusBar ai="Claude Code" dir="" machine={null} provider="claude" model="Opus" context={null} info={undefined} {...live} />);
		const bar = screen.getByRole("group", { name: "Trạng thái phiên" });
		expect(bar.querySelector(".mx-usage")).toBeNull();
		expect(bar.querySelector(".mx-mode")).toBeNull();
		expect(within(bar).getByText("Opus")).toBeTruthy();
	});

	it("shows an unknown permission mode as is, without the warning", () => {
		wrap(<StatusBar ai="Claude Code" dir="" machine={null} provider="claude" model="" context={null} info={create(ThreadInfoSchema, { permissionMode: "dontAsk" })} {...live} />);
		expect(screen.getByText("dontAsk").closest(".mx-mode")?.classList.contains("warn")).toBe(false);
	});

	it("switches the permission mode among the modes the machine allows", async () => {
		const user = userEvent.setup();
		const { link, sent } = fakeLink();
		const info = create(ThreadInfoSchema, { permissionMode: "default", permissionModes: ["default", "acceptEdits", "plan"] });
		wrap(<StatusBar ai="Claude Code" dir="" machine={null} provider="claude" model="" context={null} info={info} link={link} threadId="t1" online />);
		await user.click(screen.getByRole("button", { name: /Hỏi quyền/ }));
		const menu = screen.getByRole("menu", { name: "Chế độ quyền của phiên" });
		expect(within(menu).queryByText("Bỏ qua quyền")).toBeNull();
		await user.click(within(menu).getByRole("menuitemradio", { name: /Tự sửa file/ }));
		expect(sent).toEqual([{ case: "threadSetPermissionMode", value: { threadId: "t1", mode: "acceptEdits" } }]);
	});

	it("keeps the mode read-only on a machine that offers no modes", () => {
		wrap(<StatusBar ai="Claude Code" dir="" machine={null} provider="claude" model="" context={null} info={create(ThreadInfoSchema, { permissionMode: "plan" })} {...live} />);
		expect(screen.queryByRole("button", { name: /Lập kế hoạch/ })).toBeNull();
		expect(screen.getByText("Lập kế hoạch")).toBeTruthy();
	});
});

const commands = [
	create(SlashCommandSchema, { name: "review", description: "Review the changes", builtin: true }),
	create(SlashCommandSchema, { name: "compact", description: "Compact the context", builtin: true }),
	create(SlashCommandSchema, { name: "ak-review", description: "Code review skill", argumentHint: "[path]" }),
	create(SlashCommandSchema, { name: "deploy", description: "Ship it" }),
];

describe("slash commands", () => {
	it("opens only while a command name is typed at the start", () => {
		expect(commandToken("/rev")).toEqual({ start: 0, end: 4, query: "rev" });
		expect(commandToken("/")?.query).toBe("");
		expect(commandToken("/review now")).toBeNull();
		expect(commandToken("hi /review")).toBeNull();
		expect(commandToken("hi\n/review")).toBeNull();
	});

	it("filters by name, names starting with the text first, the AI's own commands apart", () => {
		const groups = filterCommands(commands, "REV");
		expect(groups.builtin.map((c) => c.name)).toEqual(["review"]);
		expect(groups.skills.map((c) => c.name)).toEqual(["ak-review"]);
		expect(flatCommands(filterCommands(commands, "")).map((c) => c.name)).toEqual(["review", "compact", "ak-review", "deploy"]);
		expect(flatCommands(filterCommands(commands, "zzz"))).toEqual([]);
	});

	const composer = (list = commands) => {
		const onSend = vi.fn(() => Promise.resolve());
		wrap(<Composer ai="Claude Code" machine="Mac" online running={false} prompting={false} commands={list} onSend={onSend} onStop={() => Promise.resolve()} />);
		return { onSend, field: screen.getByRole("textbox", { name: "Tin nhắn" }) };
	};

	it("is an editor rather than a form field, which password managers leave alone", () => {
		const { field } = composer();
		expect(field.tagName).toBe("DIV");
		expect(field.getAttribute("contenteditable")).toBe("true");
		expect(field.getAttribute("aria-multiline")).toBe("true");
		expect(field.getAttribute("autocomplete")).toBe("off");
		expect(field.getAttribute("enterkeyhint")).toBe("send");
		expect(document.querySelector("textarea")).toBeNull();
	});

	it("takes the focus when a session opens on a computer, not on a phone", async () => {
		const pointer = (fine: boolean) =>
			Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: (query: string) => ({ matches: fine && query.includes("pointer: fine"), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }) });
		try {
			pointer(true);
			const computer = composer();
			await waitFor(() => expect(document.activeElement).toBe(computer.field));
			cleanup();
			pointer(false);
			const phone = composer();
			await waitFor(() => expect(phone.field.getAttribute("contenteditable")).toBe("true"));
			expect(document.activeElement).not.toBe(phone.field);
		} finally {
			Reflect.deleteProperty(window, "matchMedia");
		}
	});

	it("picks with the arrow keys and Enter, keeping the focus, and sends the command as text", async () => {
		const user = userEvent.setup();
		const { onSend, field } = composer();
		await user.type(field, "/rev");
		const list = screen.getByRole("listbox", { name: "Lệnh và skill" });
		expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["/reviewReview the changes", "/ak-review[path]Code review skill"]);
		expect(within(list).getByRole("group", { name: "Lệnh của Claude Code" })).toBeTruthy();
		expect(within(list).getByRole("group", { name: "Skill" })).toBeTruthy();
		expect(field.getAttribute("aria-activedescendant")).toBe(within(list).getAllByRole("option")[0]?.id);
		await user.keyboard("{ArrowDown}");
		const second = within(list).getAllByRole("option")[1];
		expect(second?.getAttribute("aria-selected")).toBe("true");
		expect(field.getAttribute("aria-activedescendant")).toBe(second?.id);
		await user.keyboard("{Enter}");
		expect(boxValue(field)).toBe("/ak-review ");
		expect(document.activeElement).toBe(field);
		expect(screen.queryByRole("listbox")).toBeNull();
		expect(onSend).not.toHaveBeenCalled();
		await user.type(field, "src{Enter}");
		expect(onSend).toHaveBeenCalledWith("/ak-review src", []);
	});

	it("inserts with Tab or a click, and closes on Esc until the text changes", async () => {
		const user = userEvent.setup();
		const { field } = composer();
		await user.type(field, "/dep");
		await user.keyboard("{Tab}");
		expect(boxValue(field)).toBe("/deploy ");
		await user.clear(field);
		await user.type(field, "/");
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("listbox")).toBeNull();
		await user.type(field, "c");
		const option = screen.getByRole("option", { name: /compact/ });
		fireEvent.pointerDown(option);
		await user.click(option);
		expect(boxValue(field)).toBe("/compact ");
	});

	it("picks an option when a finger lifts from it, once, and not when the pointer was cancelled by a scroll", async () => {
		const user = userEvent.setup();
		const { field } = composer();
		await user.type(field, "/c");
		const option = screen.getByRole("option", { name: /compact/ });
		fireEvent.pointerDown(option, { pointerType: "touch" });
		fireEvent.pointerCancel(option, { pointerType: "touch" });
		expect(boxValue(field)).toBe("/c");
		fireEvent.pointerDown(option, { pointerType: "touch" });
		fireEvent.pointerUp(option, { pointerType: "touch" });
		expect(boxValue(field)).toBe("/compact ");
	});

	it("shows nothing while no commands are known", async () => {
		const user = userEvent.setup();
		const { onSend, field } = composer([]);
		await user.type(field, "/help{Enter}");
		expect(screen.queryByRole("listbox")).toBeNull();
		expect(onSend).toHaveBeenCalledWith("/help", []);
	});

	it("breaks the line on Shift+Enter, sends the lines on Enter and empties the box", async () => {
		const user = userEvent.setup();
		const { onSend, field } = composer();
		await user.type(field, "dòng một{Shift>}{Enter}{/Shift}dòng hai");
		expect(onSend).not.toHaveBeenCalled();
		expect(boxValue(field)).toBe("dòng một\ndòng hai");
		await user.keyboard("{Enter}");
		expect(onSend).toHaveBeenCalledWith("dòng một\ndòng hai", []);
		expect(boxValue(field)).toBe("");
		expect(document.activeElement).toBe(field);
	});
});
