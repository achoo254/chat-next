// AI Agent: the machine state in words, the sessions column's grouping and
// filters, the /ai routes (and old /machines links), the markdown of
// answers, code highlighting, diffs with line numbers, the session's
// changed files, the prompt card's keys and "deny and tell", and the
// composer's single send/stop button and "@" files.
import { create } from "@bufbuild/protobuf";
import { Decision, ItemSchema, PromptState, ThreadState, ToolKind, type ApprovalItem, type ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { ServicesContext, type Services } from "../../src/messaging/data/services.tsx";
import { setAgentNeeds } from "../../src/machines/agent-needs.ts";
import { ApprovalCard } from "../../src/machines/cards/approval.tsx";
import { diffLines } from "../../src/machines/cards/diff.tsx";
import { Composer, mentionAt, type ListFiles } from "../../src/machines/composer.tsx";
import { connOf, shouldConnect } from "../../src/machines/machine-status.ts";
import { highlight, languageOfPath } from "../../src/machines/rich/highlight.ts";
import Markdown, { safeHref } from "../../src/machines/rich/markdown.tsx";
import { versionAtLeast } from "../../src/machines/session-chat.tsx";
import { byFolder, matches } from "../../src/machines/session-sidebar.tsx";
import { sessionChanges } from "../../src/machines/transcript/changes.ts";
import { canonicalAiPath } from "../../src/machines/ai-paths.ts";
import { matchRoute, paths } from "../../src/router.tsx";

/** The copy buttons announce through the app's toasts. */
const services = { toasts: { show: () => undefined } } as unknown as Services;
const wrap = (node: ReactNode) =>
	render(
		<I18nProvider>
			<ServicesContext value={services}>{node}</ServicesContext>
		</I18nProvider>,
	);
const NOW = 1_800_000_000_000;
const online = { ref: "1", lastSeenAt: NOW / 1000 - 10, tunnelUrl: "wss://m.example" };
const idle = { status: { kind: "idle" } } as const;

describe("machine state", () => {
	it("names why a machine cannot be used, before and after its link ran", () => {
		expect(connOf(online, false, idle, NOW)).toEqual({ kind: "unpaired" });
		expect(connOf(online, null, idle, NOW)).toEqual({ kind: "checking" });
		expect(connOf(online, true, idle, NOW)).toEqual({ kind: "connecting" });
		expect(connOf(online, true, { status: { kind: "offline", attempt: 3 } }, NOW)).toEqual({ kind: "retrying", attempt: 3 });
		expect(connOf({ ...online, lastSeenAt: NOW / 1000 - 3600 }, true, idle, NOW)).toEqual({ kind: "offline", lastSeenMs: NOW - 3_600_000 });
		expect(connOf(online, true, { status: { kind: "failed", reason: "revoked" } }, NOW)).toEqual({ kind: "repair" });
		expect(connOf(online, true, { status: { kind: "failed", reason: "version" } }, NOW)).toEqual({ kind: "update" });
		expect(connOf(online, true, { status: { kind: "open" } }, NOW)).toEqual({ kind: "on" });
	});

	it("opens links only to paired machines the directory sees online", () => {
		expect(shouldConnect(online, true, NOW)).toBe(true);
		expect(shouldConnect(online, false, NOW)).toBe(false);
		expect(shouldConnect(online, null, NOW)).toBe(false);
		expect(shouldConnect({ ...online, tunnelUrl: "" }, true, NOW)).toBe(false);
		expect(shouldConnect({ ...online, lastSeenAt: 0 }, true, NOW)).toBe(false);
	});
});

describe("sessions column", () => {
	const thread = (id: string, dir: string, state: ThreadState, updatedAt: number): ThreadSummary =>
		({ id, dir, state, updatedAt: BigInt(updatedAt), title: id, provider: "claude", model: "", pending: 0, open: true }) as unknown as ThreadSummary;

	it("groups by folder, the folder of the most urgent session first", () => {
		const list = [thread("a", "~/x", ThreadState.IDLE, 3), thread("b", "~/y", ThreadState.WAITING, 1), thread("c", "~/x", ThreadState.RUNNING, 2)];
		expect(byFolder(list).map((f) => [f.dir, f.threads.map((t) => t.id)])).toEqual([
			["~/y", ["b"]],
			["~/x", ["c", "a"]],
		]);
	});

	it("filters on what needs the user and what runs", () => {
		expect(matches("need", { state: ThreadState.WAITING })).toBe(true);
		expect(matches("need", { state: ThreadState.RUNNING })).toBe(false);
		expect(matches("running", { state: ThreadState.QUEUED })).toBe(true);
		expect(matches("all", { state: ThreadState.IDLE })).toBe(true);
	});
});

describe("routes", () => {
	it("lives under /ai, with the boards and the machine pages", () => {
		expect(paths.machineSession("4", "t_1")).toBe("/ai/4/s/t_1");
		expect(matchRoute("/ai")).toEqual({ name: "machines", view: { page: "list" } });
		expect(matchRoute("/ai/need")).toEqual({ name: "machines", view: { page: "need" } });
		expect(matchRoute("/ai/machines")).toEqual({ name: "machines", view: { page: "machines" } });
		expect(matchRoute("/ai/4/s/t_1")).toEqual({ name: "machines", view: { page: "session", machine: "4", threadId: "t_1" } });
	});

	it("still opens old /machines links and sends them to /ai with their query", () => {
		expect(matchRoute("/machines/4/info")).toEqual({ name: "machines", view: { page: "info", machine: "4" } });
		expect(canonicalAiPath("/machines/4", "?session=t_1")).toBe("/ai/4?session=t_1");
		expect(canonicalAiPath("/machines", "")).toBe("/ai");
		expect(canonicalAiPath("/ai/4", "")).toBeNull();
		expect(canonicalAiPath("/machinesx", "")).toBeNull();
	});

	it("counts the sessions that need the user for the navigation, never below zero", () => {
		setAgentNeeds(-3);
		setAgentNeeds(2.7);
		setAgentNeeds(0);
	});
});

describe("markdown", () => {
	it("opens only http(s) and mailto links", () => {
		expect(safeHref("https://example.com/a")).toBe("https://example.com/a");
		expect(safeHref("mailto:a@example.com")).toBe("mailto:a@example.com");
		expect(safeHref("javascript:alert(1)")).toBeNull();
		expect(safeHref("data:text/html,x")).toBeNull();
		expect(safeHref("/relative")).toBeNull();
	});

	it("renders lists, tables, code with a copy button and links in a new tab, never raw HTML", () => {
		const text = [
			"## Kết quả",
			"",
			"- **một** và `code`",
			"- [x] xong",
			"",
			"| A | B |",
			"|---|--:|",
			"| 1 | 2 |",
			"",
			"```ts",
			"const a = 1; // note",
			"```",
			"",
			'<img src=x onerror="alert(1)"> [docs](https://example.com) [bad](javascript:alert(1))',
		].join("\n");
		const { container } = wrap(<Markdown text={text} streaming={false} />);
		expect(screen.getByRole("heading", { name: "Kết quả" })).toBeTruthy();
		expect(container.querySelector("strong")?.textContent).toBe("một");
		expect(container.querySelector("li code")?.textContent).toBe("code");
		expect(container.querySelector(".md-box.on")).toBeTruthy();
		expect(container.querySelector("td[style]")?.getAttribute("style")).toContain("right");
		expect(container.querySelector("pre code .hl-keyword")?.textContent).toBe("const");
		expect(container.querySelector("pre code .hl-comment")?.textContent).toBe("// note");
		expect(screen.getByRole("button", { name: "Sao chép" })).toBeTruthy();
		expect(container.querySelector("img")).toBeNull();
		expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
		const link = screen.getByRole("link", { name: /docs/ });
		expect(link.getAttribute("target")).toBe("_blank");
		expect(link.getAttribute("rel")).toBe("noopener noreferrer");
		expect(screen.queryByRole("link", { name: /bad/ })).toBeNull();
	});

	it("shows characters as typed, without double escaping", () => {
		const { container } = wrap(<Markdown text={"a < b && `x > y` \\* \"q\""} streaming={false} />);
		expect(container.textContent).toBe('a < b && x > y * "q"');
	});
});

describe("highlighting", () => {
	it("marks comments, strings, numbers and keywords; unknown languages stay plain", () => {
		expect(highlight('echo "hi" # c', "sh").map((p) => p.kind)).toEqual(["keyword", "plain", "string", "plain", "comment"]);
		expect(highlight("x = 42", "py").find((p) => p.kind === "number")?.text).toBe("42");
		expect(highlight("SELECT 1", "sql")[0]).toEqual({ kind: "keyword", text: "SELECT" });
		expect(highlight("anything", null)).toEqual([{ kind: "plain", text: "anything" }]);
		expect(languageOfPath("apps/web/src/a.tsx")).toBe("js");
		expect(languageOfPath("Dockerfile")).toBe("sh");
		expect(languageOfPath("README")).toBeNull();
	});
});

describe("diffs and changes", () => {
	it("numbers old and new lines from each hunk", () => {
		const lines = diffLines("--- a/x\n+++ b/x\n@@ -10,3 +10,3 @@\n a\n-b\n+c\n d\n");
		expect(lines.map((l) => [l.kind, l.old, l.new])).toEqual([
			["meta", null, null],
			["meta", null, null],
			["hunk", null, null],
			["ctx", 10, 10],
			["del", 11, null],
			["add", null, 11],
			["ctx", 12, 12],
		]);
	});

	it("gathers the session's edits by file, in the order first changed", () => {
		const diff = (id: string, path: string, added: number, removed: number) =>
			create(ItemSchema, { id, body: { case: "diff", value: { path, unified: "", added, removed } } });
		const text = create(ItemSchema, { id: "t", body: { case: "text", value: { text: "hi" } } });
		const changes = sessionChanges([diff("1", "b.ts", 2, 1), text, diff("2", "a.ts", 1, 0), diff("3", "b.ts", 3, 3)]);
		expect(changes.map((c) => [c.path, c.added, c.removed, c.edits.map((e) => e.id)])).toEqual([
			["b.ts", 5, 4, ["1", "3"]],
			["a.ts", 1, 0, ["2"]],
		]);
	});
});

describe("prompt card above the composer", () => {
	const approval = { toolId: "9", kind: ToolKind.SHELL, name: "Bash", summary: "rm -rf dist", state: PromptState.PENDING, sensitive: false, reason: "" } as unknown as ApprovalItem;

	it("answers 1, 2 and Esc from the keyboard, but not while typing", async () => {
		const user = userEvent.setup();
		const onDecide = vi.fn((_d: Decision, _m?: string) => Promise.resolve());
		wrap(
			<>
				<input aria-label="other" />
				<ApprovalCard hotkeys approval={approval} ai="Claude Code" sessionAllow onDecide={onDecide} />
			</>,
		);
		await user.click(screen.getByRole("textbox", { name: "other" }));
		await user.keyboard("1");
		expect(onDecide).not.toHaveBeenCalled();
		(document.activeElement as HTMLElement).blur();
		await user.keyboard("1");
		await user.keyboard("2");
		await user.keyboard("{Escape}");
		expect(onDecide.mock.calls.map((c) => c[0])).toEqual([Decision.ALLOW, Decision.ALLOW_SESSION, Decision.DENY]);
		expect(screen.getByRole("button", { name: /Từ chối$/ }).classList.contains("danger-outline")).toBe(true);
	});

	it("denies with a message to the AI (key 3), Esc closing the message first", async () => {
		const user = userEvent.setup();
		const onDecide = vi.fn((_d: Decision, _m?: string) => Promise.resolve());
		wrap(<ApprovalCard hotkeys approval={approval} ai="Claude Code" sessionAllow={false} onDecide={onDecide} />);
		expect(screen.queryByRole("button", { name: /Cho phép cả phiên/ })).toBeNull();
		await user.keyboard("3");
		const field = await screen.findByPlaceholderText("Bảo Claude nên làm gì thay vào đó");
		await user.type(field, "chỉ xoá dist/cache{Enter}");
		expect(onDecide).toHaveBeenCalledWith(Decision.DENY, "chỉ xoá dist/cache");
	});

	it("shows what the user told the AI on the answered prompt", () => {
		const done = { ...approval, state: PromptState.ANSWERED, decision: Decision.DENY, denyMessage: "dùng pnpm clean" } as unknown as ApprovalItem;
		wrap(<ApprovalCard approval={done} ai="Claude Code" sessionAllow onDecide={() => Promise.resolve()} />);
		expect(screen.getByText(/Đã từ chối: “dùng pnpm clean”/)).toBeTruthy();
	});
});

describe("composer", () => {
	const setup = (props: { running?: boolean; prompting?: boolean; listFiles?: ListFiles } = {}) => {
		const onSend = vi.fn((_text: string) => Promise.resolve());
		const onStop = vi.fn(() => Promise.resolve());
		wrap(
			<Composer
				ai="Claude Code"
				machine="Mac"
				online
				running={props.running ?? false}
				prompting={props.prompting ?? false}
				commands={[]}
				listFiles={props.listFiles}
				onSend={onSend}
				onStop={onStop}
			/>,
		);
		return { onSend, onStop, field: screen.getByRole("textbox", { name: "Tin nhắn" }) as HTMLTextAreaElement };
	};

	it("has one button: Stop while a turn runs and nothing is typed, queueing once there is text", async () => {
		const user = userEvent.setup();
		const { onSend, onStop, field } = setup({ running: true });
		expect(screen.queryByRole("button", { name: "Gửi" })).toBeNull();
		await user.click(screen.getByRole("button", { name: "Dừng" }));
		expect(onStop).toHaveBeenCalledTimes(1);
		await user.type(field, "rồi chạy test");
		expect(screen.queryByRole("button", { name: "Dừng" })).toBeNull();
		await user.click(screen.getByRole("button", { name: "Gửi vào hàng chờ" }));
		expect(onSend).toHaveBeenCalledWith("rồi chạy test");
	});

	it("stops with Esc, unless a prompt waits for an answer", async () => {
		const user = userEvent.setup();
		const first = setup({ running: true });
		await user.click(first.field);
		await user.keyboard("{Escape}");
		expect(first.onStop).toHaveBeenCalledTimes(1);
	});

	it("does not stop with Esc while a prompt waits", async () => {
		const user = userEvent.setup();
		const { onStop, field } = setup({ running: true, prompting: true });
		await user.click(field);
		await user.keyboard("{Escape}");
		expect(onStop).not.toHaveBeenCalled();
	});

	it("finds the '@' being typed before the caret", () => {
		expect(mentionAt("xem @src/ma", 11)).toEqual({ start: 4, query: "src/ma" });
		expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
		expect(mentionAt("me@example.com", 14)).toBeNull();
		expect(mentionAt("xem @a b", 8)).toBeNull();
	});

	it("suggests the session folder's files for '@' and inserts the pick", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
			const listFiles = vi.fn<ListFiles>((prefix) =>
				Promise.resolve({ entries: [{ path: `src/${prefix}a.ts`, dir: false }, { path: "src/lib/", dir: true }], truncated: false }),
			);
			const { field } = setup({ listFiles });
			await user.type(field, "xem @ma");
			await act(() => vi.advanceTimersByTimeAsync(200));
			const list = await screen.findByRole("listbox", { name: "File trong thư mục phiên" });
			expect(listFiles).toHaveBeenLastCalledWith("ma");
			expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["src/maa.ts", "src/lib/"]);
			await user.keyboard("{Enter}");
			expect(field.value).toBe("xem @src/maa.ts ");
		} finally {
			vi.useRealTimers();
		}
	});

	it("offers no files when the machine cannot list them", async () => {
		const user = userEvent.setup();
		const { field } = setup();
		await user.type(field, "@src");
		expect(screen.queryByRole("listbox")).toBeNull();
	});
});

describe("agent version", () => {
	it("compares tunelo versions", () => {
		expect(versionAtLeast("2.0.1", [2, 0, 1])).toBe(true);
		expect(versionAtLeast("v2.1.0-beta", [2, 0, 1])).toBe(true);
		expect(versionAtLeast("2.0.0", [2, 0, 1])).toBe(false);
		expect(versionAtLeast("", [2, 0, 1])).toBe(false);
	});
});
