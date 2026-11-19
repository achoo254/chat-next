// A folder macOS protects: the question before tunelo asks macOS, then the
// machine's answer as its info reports it.
import { create } from "@bufbuild/protobuf";
import { ApprovalItemSchema, MacFolderAccess, MachineInfoSchema, PromptState, ToolKind } from "@achoo254/chat-proto/remote/remote";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { ApprovalCard } from "../../src/machines/cards/approval.tsx";
import type { LinkState } from "../../src/machines/link/machine-link.ts";
import { MacFolderAccessDialog, MacFoldersCard, TerminalFolderNotice, folderLabel, grantedSince } from "../../src/machines/mac-folder-access.tsx";

const HOME = "/Users/me";
const DOCS = `${HOME}/Documents`;

function stateFor(access: MacFolderAccess | undefined, over: Partial<LinkState> = {}): LinkState {
	const info = create(MachineInfoSchema, {
		home: HOME,
		screenShare: true,
		macFolders: access === undefined ? [] : [{ path: DOCS, access }],
	});
	return { status: { kind: "open" }, info, macFolderAsk: DOCS, ...over } as unknown as LinkState;
}

function fakeLink() {
	const sent: { case: string; value: unknown }[] = [];
	const link = {
		request: vi.fn((body: { case: string; value: unknown }) => {
			sent.push(body);
			return Promise.resolve({ body: { case: "ack", value: {} } });
		}),
		dismissMacFolderAsk: vi.fn(),
	};
	return { link, sent };
}

const show = (link: ReturnType<typeof fakeLink>["link"], state: LinkState) =>
	render(
		<I18nProvider>
			<MacFolderAccessDialog link={link as never} state={state} />
		</I18nProvider>,
	);

describe("MacFolderAccessDialog", () => {
	it("names iCloud Drive by its name in the question", () => {
		const { link } = fakeLink();
		const icloud = `${HOME}/Library/Mobile Documents`;
		const info = create(MachineInfoSchema, { home: HOME, macFolders: [{ path: icloud, access: MacFolderAccess.NOT_ASKED }] });
		show(link, { status: { kind: "open" }, info, macFolderAsk: icloud } as unknown as LinkState);
		expect(screen.getByText("Cho tunelo vào iCloud Drive?")).toBeTruthy();
	});

	it("shows nothing while no folder waits", () => {
		const { link } = fakeLink();
		show(link, stateFor(undefined, { macFolderAsk: null }));
		expect(document.querySelector('[data-id="mac-folder"]')).toBeNull();
	});

	it("says why and asks macOS only once the user taps, then waits for the machine's answer", async () => {
		const { link, sent } = fakeLink();
		const state = stateFor(MacFolderAccess.NOT_ASKED);
		const view = show(link, state);
		expect(screen.getByText(/Cho tunelo vào ~\/Documents\?/)).toBeTruthy();
		expect(screen.getByText(/giống Claude Code chạy trong Terminal/)).toBeTruthy();
		expect(sent).toEqual([]);
		fireEvent.click(screen.getByText("Xin quyền"));
		expect(sent).toEqual([{ case: "macFolderAccessAsk", value: { path: DOCS } }]);
		await waitFor(() => expect(screen.getByText(/Đang chờ macOS/)).toBeTruthy());
		// The machine's next info carries the prompt on its screen: the screen is one tap away.
		view.rerender(
			<I18nProvider>
				<MacFolderAccessDialog link={link as never} state={stateFor(MacFolderAccess.ASKING)} />
			</I18nProvider>,
		);
		expect(screen.getByText(/Đang chờ macOS/)).toBeTruthy();
		expect(document.querySelector('[data-id="mac-folder-screen"]')).toBeTruthy();
		view.rerender(
			<I18nProvider>
				<MacFolderAccessDialog link={link as never} state={stateFor(MacFolderAccess.GRANTED)} />
			</I18nProvider>,
		);
		expect(screen.getByText(/tunelo đã vào được ~\/Documents/)).toBeTruthy();
		fireEvent.click(screen.getByText("Đóng"));
		expect(link.dismissMacFolderAsk).toHaveBeenCalled();
	});

	it("a refusal says where to allow it again, and checks again on a tap", () => {
		const { link, sent } = fakeLink();
		show(link, stateFor(MacFolderAccess.DENIED));
		expect(screen.getByText(/Tệp và thư mục/)).toBeTruthy();
		fireEvent.click(screen.getByText("Kiểm tra lại"));
		expect(sent).toEqual([{ case: "macFolderAccessAsk", value: { path: DOCS } }]);
	});

	it("'Để sau' closes without asking anything", () => {
		const { link, sent } = fakeLink();
		show(link, stateFor(MacFolderAccess.NOT_ASKED));
		fireEvent.click(screen.getByText("Để sau"));
		expect(link.dismissMacFolderAsk).toHaveBeenCalled();
		expect(sent).toEqual([]);
	});
});

describe("folderLabel", () => {
	it("shortens the home folder to ~", () => {
		expect(folderLabel(DOCS, HOME)).toBe("~/Documents");
		expect(folderLabel("/Volumes/USB", HOME)).toBe("/Volumes/USB");
	});
});

describe("an approval card for a call naming a folder macOS protects", () => {
	const card = (macFolder: string) =>
		create(ApprovalItemSchema, { toolId: "tu", kind: ToolKind.READ, name: "Read", summary: `${DOCS}/a.md`, input: "{}", reason: "It names a folder macOS protects", macFolder, state: PromptState.PENDING });

	it("says in the user's language that macOS is asked first and the AI goes on, never for the session", () => {
		render(
			<I18nProvider>
				<ApprovalCard approval={card(DOCS)} ai="Claude" sessionAllow onDecide={async () => undefined} />
			</I18nProvider>,
		);
		expect(screen.getByText(/thư mục macOS bảo vệ/).textContent).toMatch(/45 giây thì AI bỏ qua việc này và làm tiếp/);
		expect(screen.queryByText(/It names a folder macOS protects/)).toBeNull();
		expect(screen.queryByRole("button", { name: /Cho phép trong phiên này/ })).toBeNull();
	});

	it("keeps the usual card otherwise", () => {
		render(
			<I18nProvider>
				<ApprovalCard approval={card("")} ai="Claude" sessionAllow onDecide={async () => undefined} />
			</I18nProvider>,
		);
		expect(document.querySelector('[data-id="approval-mac-folder"]')).toBeNull();
		expect(screen.getByRole("button", { name: /Cho phép trong phiên này/ })).toBeTruthy();
	});
});

describe("the machine's list of folders macOS protects", () => {
	const ICLOUD = `${HOME}/Library/Mobile Documents`;
	const listState = (folders: { path: string; access: MacFolderAccess }[], online = true): LinkState =>
		({ status: { kind: online ? "open" : "closed" }, info: create(MachineInfoSchema, { home: HOME, macFolders: folders }), macFolderAsk: null }) as unknown as LinkState;
	const showList = (state: LinkState, showMacFolderAsk = vi.fn()) =>
		render(
			<I18nProvider>
				<MacFoldersCard link={{ showMacFolderAsk }} state={state} />
			</I18nProvider>,
		);

	it("names each folder with its access, iCloud Drive by name, and asks only for those not allowed", () => {
		const ask = vi.fn();
		showList(
			listState([
				{ path: `${HOME}/Desktop`, access: MacFolderAccess.GRANTED },
				{ path: ICLOUD, access: MacFolderAccess.NOT_ASKED },
				{ path: DOCS, access: MacFolderAccess.DENIED },
			]),
			ask,
		);
		const rows = [...document.querySelectorAll('[data-id="mac-folder-row"]')];
		expect(rows.map((r) => r.getAttribute("data-access"))).toEqual(["GRANTED", "NOT_ASKED", "DENIED"]);
		expect(rows[0]?.textContent).toContain("Đã cho");
		// A folder named by its path shows it once; iCloud Drive shows its path under its name.
		expect(rows[0]?.querySelectorAll(".mono")).toHaveLength(0);
		expect(rows[0]?.querySelector('[data-id="mac-folder-row-ask"]')).toBeNull();
		expect(rows[1]?.textContent).toContain("iCloud Drive");
		expect(rows[1]?.textContent).toContain("~/Library/Mobile Documents");
		expect(rows[2]?.textContent).toContain("macOS chặn");
		// Asking opens the same question as a refused task, for that folder.
		fireEvent.click(rows[1]?.querySelector('[data-id="mac-folder-row-ask"]') as Element);
		expect(ask).toHaveBeenCalledWith(ICLOUD);
		expect(rows[2]?.querySelector('[data-id="mac-folder-row-ask"]')?.textContent).toBe("Kiểm tra lại");
	});

	it("shows nothing for a machine that reports no protected folders (not a Mac, or an older tunelo)", () => {
		showList(listState([]));
		expect(document.querySelector('[data-id="machine-mac-folders"]')).toBeNull();
	});

	it("cannot ask while the machine is offline", () => {
		showList(listState([{ path: ICLOUD, access: MacFolderAccess.NOT_ASKED }], false));
		expect((document.querySelector('[data-id="mac-folder-row-ask"]') as HTMLButtonElement).disabled).toBe(true);
	});
});

describe("a terminal opened before a folder was allowed", () => {
	const ICLOUD = `${HOME}/Library/Mobile Documents`;
	const at = (access: MacFolderAccess): LinkState =>
		({ status: { kind: "open" }, info: create(MachineInfoSchema, { home: HOME, macFolders: [{ path: `${HOME}/Desktop`, access: MacFolderAccess.GRANTED }, { path: ICLOUD, access }] }), macFolderAsk: null }) as unknown as LinkState;
	const notice = (state: LinkState) => (
		<I18nProvider>
			<TerminalFolderNotice machine="1" state={state} />
		</I18nProvider>
	);

	it("only the folders allowed since count", () => {
		const before = at(MacFolderAccess.NOT_ASKED).info?.macFolders ?? [];
		const after = at(MacFolderAccess.GRANTED).info?.macFolders ?? [];
		expect(grantedSince(before, after)).toEqual([ICLOUD]);
		expect(grantedSince(after, after)).toEqual([]);
	});

	it("says to open the terminal again once macOS allows a folder, links to the list, and hides on request", () => {
		const view = render(notice(at(MacFolderAccess.NOT_ASKED)));
		expect(document.querySelector('[data-id="terminal-folder-reopen"]')).toBeNull();
		view.rerender(notice(at(MacFolderAccess.ASKING)));
		expect(document.querySelector('[data-id="terminal-folder-reopen"]')).toBeNull();
		view.rerender(notice(at(MacFolderAccess.GRANTED)));
		const bar = document.querySelector('[data-id="terminal-folder-reopen"]');
		expect(bar?.textContent).toContain("Đã cho tunelo vào iCloud Drive");
		expect(bar?.textContent).toContain("mở lại terminal");
		expect(screen.getByRole("link", { name: "Quyền thư mục" }).getAttribute("href")).toBe("/ai/1/info");
		fireEvent.click(screen.getByRole("button", { name: "Ẩn" }));
		expect(document.querySelector('[data-id="terminal-folder-reopen"]')).toBeNull();
	});
});
