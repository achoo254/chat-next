// "Phiên mới" starts without typing: it opens in the newest session's folder,
// leaves the first message empty (optional), offers one-tap ideas that follow
// the folder, and opens the session waiting when no message is given. Project settings
// in a folder the machine does not trust yet ask to trust it right there.
import { create } from "@bufbuild/protobuf";
import { ErrorCode, ErrorReason, ThreadSummarySchema, type ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { RemoteError, type LinkState, type MachineLink } from "../../src/machines/link/machine-link.ts";
import { isHome, NewSession } from "../../src/machines/new-session.tsx";
import { folderName, inDiskAccessFolder, pathCrumbs, recentFolders } from "../../src/machines/new-session-hints.ts";
import { boxValue } from "../support/plain-text-box.ts";

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
				if (path === missing) return Promise.reject(new RemoteError(ErrorCode.INVALID, "no such folder", ErrorReason.FOLDER_NOT_FOUND, ""));
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

const stateWith = (threads: ThreadSummary[], listed = true, info: unknown = null): LinkState =>
	({
		status: { kind: "open" },
		info,
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
/** The first message's box (a message box like the composer's, not a textarea). */
const message = () => screen.getByRole("textbox", { name: "Câu đầu tiên" });
const messageText = () => boxValue(message());

describe("recent folders", () => {
	it("lists session folders newest first, then the machine's own, without repeats", () => {
		const threads = [thread("a", "/w/old", 1), thread("b", "/w/new", 3), thread("c", "/w/new", 2), thread("d", "", 4)];
		expect(recentFolders(threads, ["/w/old", "/w/other"])).toEqual(["/w/new", "/w/old", "/w/other"]);
		expect(recentFolders([])).toEqual([]);
		expect(folderName("D:\\CONG VIEC\\chat-next")).toBe("chat-next");
	});
});

describe("new session", () => {
	it("opens in the newest session's folder; a picked idea follows the folder", async () => {
		const { link, sent } = fakeLink();
		open(link, stateWith([thread("a", "/w/older", 1), thread("b", "/w/chat-next", 2)]));
		await waitFor(() => expect(folderInput().value).toBe("/w/chat-next"));
		expect(sent[0]).toEqual({ case: "dirList", value: { path: "/w/chat-next", showHidden: false } });
		expect(messageText()).toBe("");
		expect(screen.getByRole("button", { name: "chat-next" }).getAttribute("aria-pressed")).toBe("true");

		fireEvent.click(screen.getByRole("button", { name: "Tóm tắt dự án" }));
		expect(messageText()).toContain("chat-next");
		fireEvent.click(screen.getByRole("button", { name: "older" }));
		await waitFor(() => expect(folderInput().value).toBe("/w/older"));
		expect(messageText()).toContain("older");
	});

	it("starts with no first message: the machine opens the session waiting", async () => {
		const { link, sent } = fakeLink();
		open(link, stateWith([thread("b", "/w/chat-next", 2)]));
		await waitFor(() => expect(folderInput().value).toBe("/w/chat-next"));
		expect(messageText()).toBe("");
		fireEvent.click(screen.getByRole("button", { name: "Bắt đầu" }));
		await waitFor(() => expect(sent.some((r) => r.case === "threadCreate")).toBe(true));
		const created = sent.find((r) => r.case === "threadCreate");
		expect(created?.value.dir).toBe("/w/chat-next");
		expect(created?.value.text).toBe("");
	});

	it("an emptied message is sent empty too, and a picked idea can be unpicked", async () => {
		const { link, sent } = fakeLink();
		open(link, stateWith([thread("b", "/w/chat-next", 2)]));
		await waitFor(() => expect(folderInput().value).toBe("/w/chat-next"));
		const chip = screen.getByRole("button", { name: "Tóm tắt dự án" });
		fireEvent.click(chip);
		expect(messageText()).toContain("chat-next");
		fireEvent.click(chip);
		expect(chip.getAttribute("aria-pressed")).toBe("false");
		expect(messageText()).toBe("");
		await userEvent.click(message());
		await userEvent.keyboard("   ");
		fireEvent.click(screen.getByRole("button", { name: "Bắt đầu" }));
		await waitFor(() => expect(sent.find((r) => r.case === "threadCreate")?.value.text).toBe(""));
	});

	it("a machine before tunelo 2.0.9 refuses an empty message, so it gets the default idea", async () => {
		const { link, sent } = fakeLink();
		open(link, stateWith([thread("b", "/w/chat-next", 2)], true, { agentVersion: "2.0.8", providers: [], pinnedDirs: [], recentDirs: [], home: "/Users/x" }));
		await waitFor(() => expect(folderInput().value).toBe("/w/chat-next"));
		fireEvent.click(screen.getByRole("button", { name: "Bắt đầu" }));
		await waitFor(() => expect(sent.find((r) => r.case === "threadCreate")?.value.text).toContain("chat-next"));
	});

	it("sends the idea picked with one tap", async () => {
		const { link, sent } = fakeLink();
		open(link, stateWith([thread("b", "/w/chat-next", 2)]));
		await waitFor(() => expect(folderInput().value).toBe("/w/chat-next"));
		const chip = screen.getByRole("button", { name: "Chạy test và sửa lỗi" });
		fireEvent.click(chip);
		expect(chip.getAttribute("aria-pressed")).toBe("true");
		expect(messageText()).toMatch(/test/);
		fireEvent.click(screen.getByRole("button", { name: "Bắt đầu" }));
		await waitFor(() => expect(sent.find((r) => r.case === "threadCreate")?.value.text).toBe(messageText()));
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
		fireEvent.click(screen.getByLabelText(/Nạp cấu hình AI/));
		fireEvent.click(screen.getByRole("button", { name: "Bắt đầu" }));
		await screen.findByText("Máy chưa tin cấu hình AI của /w/chat-next");
		expect(screen.queryByText(/not trusted/)).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Tin thư mục này và mở phiên" }));
		await waitFor(() => expect(sent.filter((r) => r.case === "threadCreate")).toHaveLength(2));
		expect(sent.filter((r) => r.case === "threadCreate").map((r) => r.value.consent?.trustProject)).toEqual([false, true]);
	});

	it("opens without project settings when the user would rather not trust the folder", async () => {
		const { link, sent } = fakeLink("", "/w/chat-next");
		open(link, stateWith([thread("b", "/w/chat-next", 2)]));
		await waitFor(() => expect(folderInput().value).toBe("/w/chat-next"));
		const setting = screen.getByLabelText(/Nạp cấu hình AI/) as HTMLInputElement;
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
		const box = screen.getByRole("checkbox", { name: /Nạp cấu hình AI/ }) as HTMLInputElement;
		expect(box.disabled).toBe(true);
		expect(box.checked).toBe(false);
		expect(screen.getByText(/chính AI cũng không bao giờ tin cấu hình ở đó/)).toBeTruthy();
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

describe("going to a typed folder", () => {
	const goTo = () => screen.queryByRole("button", { name: "Đi tới" });

	it("offers Đi tới only for a folder other than the one shown, and goes there", async () => {
		const { link, sent } = fakeLink();
		open(link, stateWith([thread("a", "/w/chat-next", 1)]));
		await waitFor(() => expect(folderInput().value).toBe("/w/chat-next"));
		expect(goTo()).toBeNull();
		fireEvent.change(folderInput(), { target: { value: "/w/other" } });
		const button = goTo();
		expect(button).not.toBeNull();
		fireEvent.click(button as HTMLElement);
		await waitFor(() => expect(sent.at(-1)).toEqual({ case: "dirList", value: { path: "/w/other", showHidden: false } }));
		await waitFor(() => expect(goTo()).toBeNull());
	});

	it("says right under the field that a folder does not exist", async () => {
		const { link } = fakeLink("/w/nope");
		open(link, stateWith([thread("a", "/w/chat-next", 1)]));
		await waitFor(() => expect(folderInput().value).toBe("/w/chat-next"));
		fireEvent.change(folderInput(), { target: { value: "/w/nope" } });
		fireEvent.click(goTo() as HTMLElement);
		expect((await screen.findByRole("alert")).textContent).toBe("Không thấy thư mục này trên máy.");
	});

	it("shows that it is loading while the machine lists the folder", async () => {
		const sent: string[] = [];
		let finish: (() => void) | undefined;
		const link = {
			request: (body: { case: string; value: { path?: string } }) => {
				sent.push(body.value.path ?? "");
				if (body.value.path !== "/w/slow") {
					return Promise.resolve({ body: { case: "dirListResult", value: { path: body.value.path || HOME, parent: "/", entries: [], sensitive: false } } });
				}
				return new Promise((resolve) => {
					finish = () => resolve({ body: { case: "dirListResult", value: { path: "/w/slow", parent: "/w", entries: [], sensitive: false } } });
				});
			},
		} as unknown as MachineLink;
		open(link, stateWith([thread("a", "/w/chat-next", 1)]));
		await waitFor(() => expect(folderInput().value).toBe("/w/chat-next"));
		fireEvent.change(folderInput(), { target: { value: "/w/slow" } });
		fireEvent.click(goTo() as HTMLElement);
		expect(screen.getByText("Đang tải…")).toBeTruthy();
		finish?.();
		await waitFor(() => expect(screen.queryByText("Đang tải…")).toBeNull());
	});
});

describe("folders that need Full Disk Access", () => {
	it("are Desktop, Documents, Downloads and Library under home", () => {
		expect(inDiskAccessFolder("/Users/me/Downloads", HOME)).toBe(true);
		expect(inDiskAccessFolder("~/Documents/app", HOME)).toBe(true);
		expect(inDiskAccessFolder("/Users/me/Library/Mobile Documents/x", HOME)).toBe(true);
		expect(inDiskAccessFolder("/Users/me/code", HOME)).toBe(false);
		expect(inDiskAccessFolder("/Users/me/DesktopApps", HOME)).toBe(false);
		expect(inDiskAccessFolder("", HOME)).toBe(false);
	});

	it("warn in the dialog only while the machine lacks it", async () => {
		const { link } = fakeLink();
		const info = { home: HOME, needsFullDiskAccess: true, providers: [], pinnedDirs: [], recentDirs: [] };
		const view = open(link, stateWith([thread("a", "/Users/me/Downloads/x", 1)], true, info));
		await waitFor(() => expect(folderInput().value).toBe("/Users/me/Downloads/x"));
		expect(screen.getByRole("note").textContent).toMatch(/Full Disk Access/);
		view.unmount();
		open(fakeLink().link, stateWith([thread("a", "/Users/me/Downloads/x", 1)], true, { ...info, needsFullDiskAccess: false }));
		await waitFor(() => expect(folderInput().value).toBe("/Users/me/Downloads/x"));
		expect(screen.queryByRole("note")).toBeNull();
	});
});

describe("the folder field and the path above the list", () => {
	it("has no browser drop-down arrow, and suggests matching folders while typing", async () => {
		const { link, sent } = fakeLink();
		const view = open(link, stateWith([thread("a", "/w/chat-next", 2), thread("b", "/w/chat-web", 1)]));
		await waitFor(() => expect(folderInput().value).toBe("/w/chat-next"));
		expect(folderInput().getAttribute("list")).toBeNull();
		expect(view.container.querySelector("datalist")).toBeNull();
		fireEvent.change(folderInput(), { target: { value: "/w/chat-w" } });
		const list = screen.getByRole("list", { name: "Gợi ý thư mục" });
		expect(list.textContent).toBe("/w/chat-web");
		fireEvent.click(screen.getByRole("button", { name: "/w/chat-web" }));
		await waitFor(() => expect(sent.at(-1)).toEqual({ case: "dirList", value: { path: "/w/chat-web", showHidden: false } }));
		expect(screen.queryByRole("list", { name: "Gợi ý thư mục" })).toBeNull();
	});

	it("is a breadcrumb whose folders each go there, from home, with a text label", async () => {
		const { link, sent } = fakeLink();
		const info = { home: HOME, providers: [], pinnedDirs: [], recentDirs: [] };
		open(link, stateWith([thread("a", "/Users/me/projects/chat-next", 1)], true, info));
		const nav = await screen.findByRole("navigation", { name: "Đường dẫn thư mục" });
		await waitFor(() => expect(nav.textContent).toBe("meprojectschat-next"));
		expect(screen.queryByRole("button", { name: "Lên một cấp" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "projects" }));
		await waitFor(() => expect(sent.at(-1)).toEqual({ case: "dirList", value: { path: "/Users/me/projects", showHidden: false } }));
	});

	it("splits macOS, Linux and Windows paths", () => {
		expect(pathCrumbs("/Users/me/projects/app", "/Users/me/")).toEqual([
			{ name: "me", path: "/Users/me" },
			{ name: "projects", path: "/Users/me/projects" },
			{ name: "app", path: "/Users/me/projects/app" },
		]);
		expect(pathCrumbs("/srv/data", "/Users/me").map((c) => c.path)).toEqual(["/srv", "/srv/data"]);
		expect(pathCrumbs("C:\\Users\\Me\\code", "c:\\users\\me").map((c) => c.path)).toEqual(["C:\\Users\\Me", "C:\\Users\\Me\\code"]);
		expect(pathCrumbs("/", "/Users/me")).toEqual([]);
	});
});

it("names every button, and an icon on its own also has a tooltip", async () => {
	const { link } = fakeLink();
	const info = { home: HOME, providers: [], pinnedDirs: ["/w/pinned"], recentDirs: [] };
	open(link, stateWith([thread("a", "/Users/me/projects/chat-next", 1)], true, info));
	await screen.findByRole("navigation", { name: "Đường dẫn thư mục" });
	fireEvent.change(folderInput(), { target: { value: "/w/p" } });
	for (const button of screen.getAllByRole("button")) {
		const text = (button.textContent ?? "").trim();
		const label = button.getAttribute("aria-label") ?? "";
		expect(text !== "" || label !== "", button.outerHTML).toBe(true);
		if (text === "") expect(button.getAttribute("title"), button.outerHTML).toBeTruthy();
	}
});
