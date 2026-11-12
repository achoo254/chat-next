// "Phiên có sẵn trên máy": the Claude Code sessions the machine keeps, opened
// as a thread from the "Phiên mới" dialog. Listed by folder with where each
// came from; searched; a session that may be open elsewhere asks first, as
// do a sensitive folder and untrusted project settings.
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { ErrorCode, ErrorReason, LocalSessionSchema, ProjectSchema, type LocalSession, type Project } from "@achoo254/chat-proto/remote/remote";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { RemoteError, type LinkState, type MachineLink } from "../../src/machines/link/machine-link.ts";
import { NewSession } from "../../src/machines/new-session.tsx";

const HOME = "/Users/me";
const NOW = Date.now();

const session = (id: string, dir: string, title: string, extra: MessageInitShape<typeof LocalSessionSchema> = {}): LocalSession =>
	create(LocalSessionSchema, { sessionId: id, dir, title, updatedAt: BigInt(NOW - 2 * 3_600_000), messages: 12, entrypoint: "cli", ...extra });

interface Sent {
	case: string;
	value: Record<string, unknown> & { consent?: { sensitive?: boolean; projectSettings?: boolean; trustProject?: boolean }; openAnyway?: boolean; query?: string };
}

/** A machine keeping `sessions`; `refuse` makes it refuse to open with that error. */
const fakeLink = (sessions: LocalSession[], refuse: (sent: Sent) => RemoteError | undefined = () => undefined) => {
	const sent: Sent[] = [];
	const link = {
		request: (body: Sent) => {
			sent.push(body);
			if (body.case === "dirList") return Promise.resolve({ body: { case: "dirListResult", value: { path: HOME, parent: "/Users", entries: [], sensitive: true } } });
			if (body.case === "sessionList") {
				const words = String(body.value.query ?? "").toLowerCase();
				const matching = sessions.filter((s) => s.title.toLowerCase().includes(words));
				// As the machine does: the folders of every match, the sessions of the folder asked for (and below), one page of them.
				const dirs = [...new Set(matching.map((s) => s.dir))].map((dir) => ({ dir, sessions: matching.filter((s) => s.dir === dir).length }));
				const folder = String(body.value.dir ?? "");
				const inFolder = folder === "" ? matching : matching.filter((s) => s.dir === folder || s.dir.startsWith(`${folder}/`));
				const offset = Number(body.value.offset ?? 0);
				const limit = Number(body.value.limit ?? 30);
				return Promise.resolve({ body: { case: "sessionListResult", value: { sessions: inFolder.slice(offset, offset + limit), total: inFolder.length, dirs } } });
			}
			if (body.case === "sessionOpen") {
				const err = refuse(body);
				if (err !== undefined) return Promise.reject(err);
				return Promise.resolve({ body: { case: "threadCreated", value: { thread: { id: "opened" } } } });
			}
			return Promise.resolve({ body: { case: "ack", value: {} } });
		},
	} as unknown as MachineLink;
	return { link, sent };
};

const state = { status: { kind: "open" }, info: { home: HOME, providers: [{ id: "claude", name: "Claude Code" }] }, threads: [], listed: true, openSessions: 0, maxSessions: 3 } as unknown as LinkState;

async function openTab(link: MachineLink, project?: Project) {
	render(
		<I18nProvider>
			<NewSession machine="1" name="Mac mini" link={link} state={state} onClose={() => {}} {...(project !== undefined ? { project } : {})} />
		</I18nProvider>,
	);
	fireEvent.click(screen.getByRole("tab", { name: "Phiên có sẵn trên máy" }));
	return screen.findByRole("searchbox", { name: "Tìm theo tiêu đề, câu hỏi hoặc thư mục" });
}

const sent = (list: Sent[], c: string) => list.filter((s) => s.case === c);

afterEach(() => window.history.replaceState(null, "", "/"));

describe("sessions on the machine", () => {
	it("lists them by folder, newest first, with when, how many messages and where each came from", async () => {
		const { link } = fakeLink([
			session("a", `${HOME}/shop`, "Thêm nút thanh toán"),
			session("b", `${HOME}/shop`, "Sửa CSS giỏ hàng", { entrypoint: "sdk-ts", threadId: "t1" }),
			session("c", `${HOME}/blog`, "Viết bài mới", { entrypoint: "claude-desktop", busyElsewhere: true }),
		]);
		await openTab(link);
		const shop = await screen.findByRole("region", { name: `${HOME}/shop` });
		expect(within(shop).getByText("Thêm nút thanh toán")).toBeTruthy();
		expect(within(shop).getByText("~/shop")).toBeTruthy();
		expect(within(shop).getAllByText("2 giờ trước")).toHaveLength(2);
		expect(within(shop).getAllByText("12 tin")).toHaveLength(2);
		expect(within(shop).getByText("Terminal · IDE")).toBeTruthy();
		// Already a thread of Chat: shown as such, and viewed rather than opened again.
		expect(within(shop).getByText("Chat")).toBeTruthy();
		expect(within(shop).getByRole("button", { name: "Xem: Sửa CSS giỏ hàng" })).toBeTruthy();
		const blog = screen.getByRole("region", { name: `${HOME}/blog` });
		expect(within(blog).getByText("Claude Desktop")).toBeTruthy();
		expect(within(blog).getByText("Có thể đang mở")).toBeTruthy();
		expect(screen.getByText("3/3 phiên")).toBeTruthy();
	});

	it("searches what was typed once typing stops", async () => {
		const { link, sent: requests } = fakeLink([session("a", `${HOME}/shop`, "Thanh toán"), session("b", `${HOME}/blog`, "Bài mới")]);
		const search = await openTab(link);
		await screen.findByText("Thanh toán");
		fireEvent.change(search, { target: { value: "bài" } });
		await waitFor(() => expect(screen.queryByText("Thanh toán")).toBeNull());
		expect(screen.getByText("Bài mới")).toBeTruthy();
		expect(sent(requests, "sessionList").at(-1)?.value.query).toBe("bài");
		fireEvent.change(search, { target: { value: "không có" } });
		expect(await screen.findByText("Không có phiên nào khớp.")).toBeTruthy();
	});

	it("opens one as a thread and goes to it; a thread of Chat opens without asking the machine", async () => {
		const { link, sent: requests } = fakeLink([session("a", `${HOME}/shop`, "Thanh toán"), session("b", `${HOME}/shop`, "Giỏ hàng", { threadId: "t1" })]);
		await openTab(link);
		fireEvent.click(await screen.findByRole("button", { name: "Xem: Giỏ hàng" }));
		expect(window.location.pathname).toBe("/ai/1/s/t1");
		expect(sent(requests, "sessionOpen")).toHaveLength(0);
		fireEvent.click(screen.getByRole("button", { name: "Mở: Thanh toán" }));
		await waitFor(() => expect(window.location.pathname).toBe("/ai/1/s/opened"));
		expect(sent(requests, "sessionOpen")[0]?.value).toMatchObject({ sessionId: "a", openAnyway: false, consent: { sensitive: false, projectSettings: false } });
	});

	it("asks before opening one that may be open elsewhere, and goes on when the user says so", async () => {
		const { link, sent: requests } = fakeLink([session("a", `${HOME}/shop`, "Thanh toán", { busyElsewhere: true })]);
		await openTab(link);
		fireEvent.click(await screen.findByRole("button", { name: "Mở: Thanh toán" }));
		expect(screen.getByText("Phiên này có thể đang mở trên máy. Mở tiếp ở đây có thể làm lẫn nội dung.")).toBeTruthy();
		expect(sent(requests, "sessionOpen")).toHaveLength(0);
		fireEvent.click(screen.getByRole("button", { name: "Vẫn mở ở đây" }));
		await waitFor(() => expect(sent(requests, "sessionOpen")).toHaveLength(1));
		expect(sent(requests, "sessionOpen")[0]?.value.openAnyway).toBe(true);
	});

	it("asks what the machine asks for: the same session found open elsewhere since, then trusting its project settings", async () => {
		const { link, sent: requests } = fakeLink([session("a", `${HOME}/shop`, "Thanh toán")], (body) => {
			if (!body.value.openAnyway) return new RemoteError(ErrorCode.INVALID, "open elsewhere", ErrorReason.SESSION_OPEN_ELSEWHERE, `${HOME}/shop`);
			if (body.value.consent?.projectSettings && !body.value.consent.trustProject) {
				return new RemoteError(ErrorCode.INVALID, "not trusted", ErrorReason.PROJECT_SETTINGS_UNTRUSTED, `${HOME}/shop`);
			}
			return undefined;
		});
		await openTab(link);
		fireEvent.click(screen.getByRole("checkbox", { name: /Nạp cấu hình .claude của dự án/ }));
		fireEvent.click(await screen.findByRole("button", { name: "Mở: Thanh toán" }));
		fireEvent.click(await screen.findByRole("button", { name: "Vẫn mở ở đây" }));
		fireEvent.click(await screen.findByRole("button", { name: "Tin thư mục này và mở phiên" }));
		await waitFor(() => expect(window.location.pathname).toBe("/ai/1/s/opened"));
		expect(sent(requests, "sessionOpen").at(-1)?.value).toMatchObject({ openAnyway: true, consent: { projectSettings: true, trustProject: true } });
	});

	it("needs the user's agreement for a sensitive folder", async () => {
		const { link, sent: requests } = fakeLink([session("a", HOME, "Dọn thư mục home", { sensitive: true })]);
		await openTab(link);
		fireEvent.click(await screen.findByRole("button", { name: "Mở: Dọn thư mục home" }));
		expect(screen.getByText(`${HOME} là thư mục nhạy cảm`)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Tôi đồng ý, mở phiên" }));
		await waitFor(() => expect(sent(requests, "sessionOpen")).toHaveLength(1));
		expect(sent(requests, "sessionOpen")[0]?.value.consent).toMatchObject({ sensitive: true, projectSettings: false });
	});

	it("says when the machine keeps none", async () => {
		await openTab(fakeLink([]).link);
		expect(await screen.findByText("Máy chưa có phiên Claude Code nào.")).toBeTruthy();
	});

	it("an older machine: says to update it", async () => {
		const link = {
			request: (body: Sent) =>
				body.case === "sessionList"
					? Promise.reject(new RemoteError(ErrorCode.INVALID, "unsupported request", ErrorReason.UNSUPPORTED_REQUEST, ""))
					: Promise.resolve({ body: { case: "dirListResult", value: { path: HOME, parent: "", entries: [], sensitive: true } } }),
		} as unknown as MachineLink;
		await openTab(link);
		expect(await screen.findByText("Máy chưa hỗ trợ việc này. Cập nhật trên máy: tunelo update.")).toBeTruthy();
	});
});

describe("opened from a workspace or from the machine", () => {
	const many = [
		session("b1", `${HOME}/blog`, "Viết bài mới"),
		session("b2", `${HOME}/blog`, "Sửa ảnh bìa"),
		...Array.from({ length: 35 }, (_, i) => session(`s${i}`, `${HOME}/shop`, `Shop ${i}`)),
	];
	const workspace = create(ProjectSchema, { id: "p", name: "shop", dir: `${HOME}/shop`, git: { git: true, branch: "main" } });

	it("from a workspace: named after its folder and branch, its sessions only, paged within the folder; widened for this open only", async () => {
		const { link, sent: list } = fakeLink(many);
		await openTab(link, workspace);
		expect(screen.getByRole("heading", { name: "Phiên mới trong shop · main" })).toBeTruthy();
		await screen.findByText("Shop 0");
		const folder = screen.getByRole("combobox", { name: "Lọc theo thư mục" }) as HTMLSelectElement;
		expect(folder.value).toBe(`${HOME}/shop`);
		expect(sent(list, "sessionList")[0]?.value).toMatchObject({ dir: `${HOME}/shop` });
		expect(screen.queryByText("Viết bài mới")).toBeNull();
		// The group header names the folder; the count is the folder's.
		expect(screen.getByRole("region", { name: `${HOME}/shop` })).toBeTruthy();
		expect(screen.getByText("30/35 phiên")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Xem thêm" }));
		await screen.findByText("Shop 34");
		expect(sent(list, "sessionList").at(-1)?.value).toMatchObject({ dir: `${HOME}/shop`, offset: 30 });
		expect(screen.getByText("35/35 phiên")).toBeTruthy();
		// Widened: every folder.
		fireEvent.change(folder, { target: { value: "" } });
		await screen.findByText("Viết bài mới");
		expect(sent(list, "sessionList").at(-1)?.value).toMatchObject({ dir: "" });
		expect(screen.getByText("30/37 phiên")).toBeTruthy();
	});

	it("a workspace folder the machine lists no session in is still offered, and 'Mọi thư mục' widens it", async () => {
		const { link } = fakeLink(many);
		await openTab(link, create(ProjectSchema, { id: "q", name: "new", dir: `${HOME}/new` }));
		expect(screen.getByRole("heading", { name: "Phiên mới trong new" })).toBeTruthy();
		const folder = screen.getByRole("combobox", { name: "Lọc theo thư mục" }) as HTMLSelectElement;
		await waitFor(() => expect(folder.value).toBe(`${HOME}/new`));
		expect([...folder.options].map((o) => o.value)).toEqual(["", `${HOME}/new`, `${HOME}/blog`, `${HOME}/shop`]);
	});

	it("from the machine: named after the machine, every folder, as before", async () => {
		const { link, sent: list } = fakeLink(many);
		await openTab(link);
		expect(screen.getByRole("heading", { name: "Phiên mới trên Mac mini" })).toBeTruthy();
		await screen.findByText("Viết bài mới");
		expect((screen.getByRole("combobox", { name: "Lọc theo thư mục" }) as HTMLSelectElement).value).toBe("");
		expect(sent(list, "sessionList")[0]?.value).toMatchObject({ dir: "" });
	});

	it("each open starts again from the workspace's folder (the widening is not kept)", async () => {
		const { link } = fakeLink(many);
		const first = render(
			<I18nProvider>
				<NewSession machine="1" name="Mac mini" link={link} state={state} onClose={() => {}} project={workspace} />
			</I18nProvider>,
		);
		fireEvent.click(screen.getByRole("tab", { name: "Phiên có sẵn trên máy" }));
		const folder = (await screen.findByRole("combobox", { name: "Lọc theo thư mục" })) as HTMLSelectElement;
		fireEvent.change(folder, { target: { value: "" } });
		first.unmount();
		await openTab(link, workspace);
		await waitFor(() => expect((screen.getByRole("combobox", { name: "Lọc theo thư mục" }) as HTMLSelectElement).value).toBe(`${HOME}/shop`));
	});
});
