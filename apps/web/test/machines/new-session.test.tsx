// "Phiên mới" starts without typing: it opens in the newest session's folder,
// fills in a first message that follows the folder, offers one-tap ideas, and
// sends the default suggestion when the message is emptied. Project settings
// in a folder the machine does not trust yet ask to trust it right there.
import { create } from "@bufbuild/protobuf";
import { ErrorCode, ErrorReason, ThreadSummarySchema, type ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { RemoteError, type LinkState, type MachineLink } from "../../src/machines/link/machine-link.ts";
import { isHome, NewSession } from "../../src/machines/new-session.tsx";
import { folderName, recentFolders } from "../../src/machines/new-session-hints.ts";

const HOME = "/Users/me";
const thread = (id: string, dir: string, updatedAt: number): ThreadSummary =>
	create(ThreadSummarySchema, { id, dir, title: id, updatedAt: BigInt(updatedAt) });

interface Request {
	case: string;
	value: { path?: string; text?: string; dir?: string; consent?: { projectSettings?: boolean; trustProject?: boolean } };
}

/** A machine that lists any folder under HOME (not `missing`) and creates threads; `untrusted` needs trust for project settings. */
const fakeLink = (missing = "", untrusted = "") => {
	const sent: Request[] = [];
	const link = {
		request: (body: Request) => {
			sent.push(body);
			if (body.case === "dirList") {
				const path = body.value.path === "" ? HOME : (body.value.path ?? HOME);
				if (path === missing) return Promise.reject(new Error("gone"));
				return Promise.resolve({ body: { case: "dirListResult", value: { path, parent: "/Users", entries: [], sensitive: path === HOME } } });
			}
			if (body.case === "threadCreate") {
				const { dir, consent } = body.value;
				if (dir === untrusted && consent?.projectSettings && !consent.trustProject) {
					return Promise.reject(new RemoteError(ErrorCode.INVALID, "not trusted", ErrorReason.PROJECT_SETTINGS_UNTRUSTED, dir));
				}
				return Promise.resolve({ body: { case: "threadCreated", value: { thread: { id: "new" } } } });
			}
			return Promise.resolve({ body: { case: "ack", value: {} } });
		},
	} as unknown as MachineLink;
	return { link, sent };
};

const stateWith = (threads: ThreadSummary[], listed = true): LinkState =>
	({
		status: { kind: "open" },
		info: null,
		threads,
		listed,
		openSessions: 0,
		maxSessions: 3,
		journals: new Map(),
		full: new Map(),
		pending: new Map(),
		threadInfo: new Map(),
	}) as unknown as LinkState;

const open = (link: MachineLink, state: LinkState) =>
	render(
		<I18nProvider>
			<NewSession machine="1" name="Mac mini" link={link} state={state} onClose={() => {}} />
		</I18nProvider>,
	);
const folderInput = () => screen.getByLabelText("Thư mục") as HTMLInputElement;
const message = () => screen.getByLabelText("Câu đầu tiên") as HTMLTextAreaElement;

describe("recent folders", () => {
	it("lists session folders newest first, then the machine's own, without repeats", () => {
		const threads = [thread("a", "/w/old", 1), thread("b", "/w/new", 3), thread("c", "/w/new", 2), thread("d", "", 4)];
		expect(recentFolders(threads, ["/w/old", "/w/other"])).toEqual(["/w/new", "/w/old", "/w/other"]);
		expect(recentFolders([])).toEqual([]);
		expect(folderName("D:\\CONG VIEC\\chat-next")).toBe("chat-next");
	});
});

describe("new session", () => {
	it("opens in the newest session's folder with a suggestion that follows the folder", async () => {
		const { link, sent } = fakeLink();
		open(link, stateWith([thread("a", "/w/older", 1), thread("b", "/w/chat-next", 2)]));
		await waitFor(() => expect(folderInput().value).toBe("/w/chat-next"));
		expect(sent[0]).toEqual({ case: "dirList", value: { path: "/w/chat-next", showHidden: false } });
		expect(message().value).toContain("chat-next");
		expect(screen.getByRole("button", { name: "chat-next" }).getAttribute("aria-pressed")).toBe("true");

		fireEvent.click(screen.getByRole("button", { name: "older" }));
		await waitFor(() => expect(folderInput().value).toBe("/w/older"));
		expect(message().value).toContain("older");
	});

	it("starts at once with the suggestion, and uses the default when the message is emptied", async () => {
		const { link, sent } = fakeLink();
		open(link, stateWith([thread("b", "/w/chat-next", 2)]));
		await waitFor(() => expect(folderInput().value).toBe("/w/chat-next"));
		fireEvent.change(message(), { target: { value: "   " } });
		fireEvent.click(screen.getByRole("button", { name: "Bắt đầu" }));
		await waitFor(() => expect(sent.some((r) => r.case === "threadCreate")).toBe(true));
		const created = sent.find((r) => r.case === "threadCreate");
		expect(created?.value.dir).toBe("/w/chat-next");
		expect(created?.value.text).toContain("chat-next");
		expect(screen.queryByText("Nhập câu đầu tiên")).toBeNull();
	});

	it("sends the idea picked with one tap", async () => {
		const { link, sent } = fakeLink();
		open(link, stateWith([thread("b", "/w/chat-next", 2)]));
		await waitFor(() => expect(folderInput().value).toBe("/w/chat-next"));
		const chip = screen.getByRole("button", { name: "Chạy test và sửa lỗi" });
		fireEvent.click(chip);
		expect(chip.getAttribute("aria-pressed")).toBe("true");
		expect(message().value).toMatch(/test/);
		fireEvent.click(screen.getByRole("button", { name: "Bắt đầu" }));
		await waitFor(() => expect(sent.find((r) => r.case === "threadCreate")?.value.text).toBe(message().value));
	});

	it("keeps the home folder when the machine has no sessions, and falls back to it when the recent folder is gone", async () => {
		const empty = fakeLink();
		const first = open(empty.link, stateWith([]));
		await waitFor(() => expect(folderInput().value).toBe(HOME));
		expect(empty.sent[0]).toEqual({ case: "dirList", value: { path: "", showHidden: false } });
		first.unmount();

		const gone = fakeLink("/w/deleted");
		open(gone.link, stateWith([thread("b", "/w/deleted", 2)]));
		await waitFor(() => expect(folderInput().value).toBe(HOME));
	});

	it("asks to trust the folder's project settings, then opens with that consent", async () => {
		const { link, sent } = fakeLink("", "/w/chat-next");
		open(link, stateWith([thread("b", "/w/chat-next", 2)]));
		await waitFor(() => expect(folderInput().value).toBe("/w/chat-next"));
		fireEvent.click(screen.getByLabelText(/Nạp cấu hình .claude/));
		fireEvent.click(screen.getByRole("button", { name: "Bắt đầu" }));
		await screen.findByText("Máy chưa tin cấu hình .claude của /w/chat-next");
		expect(screen.queryByText(/not trusted/)).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Tin thư mục này và mở phiên" }));
		await waitFor(() => expect(sent.filter((r) => r.case === "threadCreate")).toHaveLength(2));
		expect(sent.filter((r) => r.case === "threadCreate").map((r) => r.value.consent?.trustProject)).toEqual([false, true]);
	});

	it("opens without project settings when the user would rather not trust the folder", async () => {
		const { link, sent } = fakeLink("", "/w/chat-next");
		open(link, stateWith([thread("b", "/w/chat-next", 2)]));
		await waitFor(() => expect(folderInput().value).toBe("/w/chat-next"));
		const setting = screen.getByLabelText(/Nạp cấu hình .claude/) as HTMLInputElement;
		fireEvent.click(setting);
		fireEvent.click(screen.getByRole("button", { name: "Bắt đầu" }));
		fireEvent.click(await screen.findByRole("button", { name: "Không nạp cấu hình dự án" }));
		expect(setting.checked).toBe(false);
		fireEvent.click(screen.getByRole("button", { name: "Bắt đầu" }));
		await waitFor(() => expect(sent.filter((r) => r.case === "threadCreate")).toHaveLength(2));
		expect(sent.filter((r) => r.case === "threadCreate").at(-1)?.value.consent).toEqual({ sensitive: false, projectSettings: false, trustProject: false });
	});

	it("waits for the session list before choosing a folder", async () => {
		const { link, sent } = fakeLink();
		const view = open(link, stateWith([], false));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(sent).toEqual([]);
		view.rerender(
			<I18nProvider>
				<NewSession machine="1" name="Mac mini" link={link} state={stateWith([thread("b", "/w/chat-next", 2)])} onClose={() => {}} />
			</I18nProvider>,
		);
		await waitFor(() => expect(folderInput().value).toBe("/w/chat-next"));
	});
});

describe("project settings in the home folder", () => {
	it("are off and locked in the home or a sensitive folder, with the reason, and free in a project", async () => {
		const { link, sent } = fakeLink();
		open(link, { ...stateWith([]), info: { home: HOME, providers: [], recentDirs: [], pinnedDirs: [] } } as unknown as LinkState);
		await waitFor(() => expect(folderInput().value).toBe(HOME));
		const box = screen.getByRole("checkbox", { name: /Nạp cấu hình .claude/ }) as HTMLInputElement;
		expect(box.disabled).toBe(true);
		expect(box.checked).toBe(false);
		expect(screen.getByText(/Claude Code cũng không bao giờ tin cấu hình ở đó/)).toBeTruthy();
		fireEvent.change(folderInput(), { target: { value: `${HOME}/code/app` } });
		expect(box.disabled).toBe(false);
		fireEvent.click(box);
		expect(box.checked).toBe(true);
		// Back home: the box shows off again and nothing asks the machine to load or trust it.
		fireEvent.change(folderInput(), { target: { value: `${HOME}/` } });
		expect(box.checked).toBe(false);
		expect(sent.filter((r) => r.case === "threadCreate")).toEqual([]);
	});

	it("knows the home folder whatever its trailing slash or, on Windows, its case", () => {
		expect(isHome("/Users/me/", "/Users/me")).toBe(true);
		expect(isHome("c:\\users\\me", "C:\\Users\\me")).toBe(true);
		expect(isHome("/Users/me/code", "/Users/me")).toBe(false);
		expect(isHome("", "/Users/me")).toBe(false);
	});
});
