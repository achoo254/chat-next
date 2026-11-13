// A folder's own AI configuration on the machine: the switch in a
// workspace's settings, the hint over a chat session that runs without it,
// and what an older machine (no per-folder level) or a sensitive folder gets.
import { create } from "@bufbuild/protobuf";
import { ErrorCode, ErrorReason, MachineInfoSchema, ProjectConfigLevel, ProjectSchema, type Project } from "@achoo254/chat-proto/remote/remote";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { RemoteError, type LinkState, type MachineLink } from "../../src/machines/link/machine-link.ts";
import { ProjectConfigHint } from "../../src/machines/project-config.tsx";
import { ProjectSettingsDialog } from "../../src/machines/project-dialogs.tsx";

const DIR = "/work/app";

interface Request {
	case: string;
	value: { dir?: string; level?: ProjectConfigLevel; defaults?: { projectSettings?: boolean } };
}

/** A machine answering ProjectConfigSet with the level set, or refusing it with `refuse`. */
const fakeLink = (refuse?: ErrorReason) => {
	const sent: Request[] = [];
	const link = {
		request: (body: Request) => {
			sent.push(body);
			if (body.case === "projectConfigSet") {
				if (refuse !== undefined) return Promise.reject(new RemoteError(ErrorCode.INVALID, "refused", refuse, refuse === ErrorReason.TRUST_ON_MACHINE ? (body.value.dir ?? "") : ""));
				return Promise.resolve({ body: { case: "projectConfig", value: { dir: body.value.dir, level: body.value.level } } });
			}
			return Promise.resolve({ body: { case: "ack", value: {} } });
		},
	} as unknown as MachineLink;
	return { link, sent };
};

const state = { status: { kind: "open" }, info: null, threads: [], threadInfo: new Map() } as unknown as LinkState;

const project = (level: ProjectConfigLevel, projectSettings = false): Project =>
	create(ProjectSchema, { id: "p1", name: "app", dir: DIR, projectConfig: level, defaults: { model: "", permissionMode: "", projectSettings } });

const openDialog = (link: MachineLink, p: Project) =>
	render(
		<I18nProvider>
			<ProjectSettingsDialog link={link} project={p} state={state} onClose={() => {}} />
		</I18nProvider>,
	);

const folderSwitch = () => screen.getByRole<HTMLInputElement>("checkbox", { name: /Dùng cấu hình AI của thư mục/ });
const sessionTick = () => screen.queryByRole<HTMLInputElement>("checkbox", { name: "Nạp cấu hình AI của dự án" });

describe("the folder's switch in a workspace's settings", () => {
	it("shows the folder's level, turns it on at once and says a running session switches after its turn", async () => {
		const { link, sent } = fakeLink();
		openDialog(link, project(ProjectConfigLevel.OFF));
		expect(folderSwitch().checked).toBe(false);
		expect(sessionTick()).toBeNull();
		expect(screen.getByText(/Phiên đang chạy đổi sau lượt hiện tại/)).toBeTruthy();
		await userEvent.click(folderSwitch());
		await waitFor(() => expect(folderSwitch().checked).toBe(true));
		expect(sent.filter((r) => r.case === "projectConfigSet")).toEqual([{ case: "projectConfigSet", value: { dir: DIR, level: ProjectConfigLevel.FULL } }]);
		// New sessions of the workspace tick what the folder says.
		await userEvent.click(screen.getByRole("button", { name: "Lưu" }));
		expect(sent.find((r) => r.case === "projectUpdate")?.value.defaults?.projectSettings).toBe(true);
	});

	it("turns a folder that is on off", async () => {
		const { link, sent } = fakeLink();
		openDialog(link, project(ProjectConfigLevel.FULL, true));
		expect(folderSwitch().checked).toBe(true);
		await userEvent.click(folderSwitch());
		await waitFor(() => expect(folderSwitch().checked).toBe(false));
		expect(sent.at(-1)).toEqual({ case: "projectConfigSet", value: { dir: DIR, level: ProjectConfigLevel.OFF } });
		await userEvent.click(screen.getByRole("button", { name: "Lưu" }));
		expect(sent.find((r) => r.case === "projectUpdate")?.value.defaults?.projectSettings).toBe(false);
	});

	it("keeps the per-session tick on a machine that does not tell the folder's level", () => {
		openDialog(fakeLink().link, project(ProjectConfigLevel.UNSPECIFIED, true));
		expect(screen.queryByRole("checkbox", { name: /Dùng cấu hình AI của thư mục/ })).toBeNull();
		expect(sessionTick()?.checked).toBe(true);
	});

	it("falls back to the per-session tick when the machine does not know the request", async () => {
		const { link } = fakeLink(ErrorReason.UNSUPPORTED_REQUEST);
		openDialog(link, project(ProjectConfigLevel.OFF));
		await userEvent.click(folderSwitch());
		expect((await screen.findByRole("status")).textContent).toContain("Máy chưa có cấu hình theo thư mục (cập nhật trên máy: tunelo update).");
		expect(sessionTick()?.checked).toBe(false);
		expect(screen.queryByRole("checkbox", { name: /Dùng cấu hình AI của thư mục/ })).toBeNull();
	});

	it("says why a sensitive folder is turned on only for a project inside it", async () => {
		const { link } = fakeLink(ErrorReason.TRUST_ON_MACHINE);
		openDialog(link, project(ProjectConfigLevel.OFF));
		await userEvent.click(folderSwitch());
		expect((await screen.findByRole("alert")).textContent).toContain(`${DIR} là thư mục nhạy cảm`);
		expect(folderSwitch().checked).toBe(false);
	});
});

const hint = (link: MachineLink, level: ProjectConfigLevel) =>
	render(
		<I18nProvider>
			<ProjectConfigHint link={link} level={level} dir={DIR} ai="Claude Code" online />
		</I18nProvider>,
	);

describe("the hint over a chat session without its project's configuration", () => {
	it("offers to turn the folder on in one tap, then says it loads from the next turn", async () => {
		const { link, sent } = fakeLink();
		hint(link, ProjectConfigLevel.OFF);
		const button = screen.getByRole("button", { name: "Nạp kỹ năng dự án" });
		expect(button.getAttribute("title")).toMatch(/Kỹ năng của dự án chưa nạp/);
		await userEvent.click(button);
		expect((await screen.findByRole("status")).textContent).toContain("Đã bật · nạp từ lượt sau");
		expect(sent).toEqual([{ case: "projectConfigSet", value: { dir: DIR, level: ProjectConfigLevel.FULL } }]);
	});

	it("shows nothing for a session that has it or a machine that does not tell", () => {
		const { link } = fakeLink();
		const view = hint(link, ProjectConfigLevel.FULL);
		expect(view.container.innerHTML).toBe("");
		view.unmount();
		expect(hint(link, ProjectConfigLevel.UNSPECIFIED).container.innerHTML).toBe("");
	});

	it("says why the machine refused", async () => {
		hint(fakeLink(ErrorReason.TRUST_ON_MACHINE).link, ProjectConfigLevel.OFF);
		await userEvent.click(screen.getByRole("button", { name: "Nạp kỹ năng dự án" }));
		expect((await screen.findByRole("alert")).textContent).toContain("không bật được từ thiết bị");
	});
});

describe("the AI of a workspace's new sessions", () => {
	const withAis = {
		...state,
		info: create(MachineInfoSchema, {
			providers: [
				{ id: "claude", name: "Claude Code", capabilities: { models: [{ id: "opus", name: "Opus" }], permissionModes: ["default", "acceptEdits", "plan"], bypassModeId: "bypassPermissions" } },
				{ id: "antigravity", name: "Antigravity", capabilities: { permissionModes: ["default", "accept-edits", "auto", "plan"], bypassModeId: "full-access" } },
			],
		}),
	} as unknown as LinkState;
	const open = (link: MachineLink, p: Project) =>
		render(
			<I18nProvider>
				<ProjectSettingsDialog link={link} project={p} state={withAis} onClose={() => {}} />
			</I18nProvider>,
		);

	it("saves the AI picked, with that AI's own modes and models", async () => {
		const { link, sent } = fakeLink();
		open(link, create(ProjectSchema, { id: "p1", name: "app", dir: DIR, defaults: { provider: "claude", model: "opus", permissionMode: "plan" } }));
		const ai = screen.getByRole<HTMLSelectElement>("combobox", { name: "AI" });
		expect(ai.value).toBe("claude");
		await userEvent.selectOptions(ai, "antigravity");
		// Another AI: the model and mode picked were the old one's.
		const mode = screen.getByRole<HTMLSelectElement>("combobox", { name: "Chế độ quyền mặc định" });
		expect(mode.value).toBe("");
		expect([...mode.options].map((o) => o.value)).toEqual(["", "default", "accept-edits", "auto", "plan"]);
		expect([...mode.options].map((o) => o.text)).toContain("Tự sửa file");
		await userEvent.selectOptions(mode, "auto");
		await userEvent.click(screen.getByRole("button", { name: "Lưu" }));
		await waitFor(() => expect(sent.find((r) => r.case === "projectUpdate")).toBeTruthy());
		const update = sent.find((r) => r.case === "projectUpdate") as unknown as { value: { defaults: { provider: string; model: string; permissionMode: string } } };
		expect(update.value.defaults).toMatchObject({ provider: "antigravity", model: "", permissionMode: "auto" });
	});

	it("lets each session pick when no AI is set, with nothing to pick for model or mode", () => {
		const { link } = fakeLink();
		open(link, create(ProjectSchema, { id: "p1", name: "app", dir: DIR }));
		expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "AI" }).value).toBe("");
		expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Chế độ quyền mặc định" }).disabled).toBe(true);
		expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Model mặc định" }).disabled).toBe(true);
	});
});
