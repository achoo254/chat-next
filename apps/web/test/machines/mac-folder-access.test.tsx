// A folder macOS protects: the question before tunelo asks macOS, then the
// machine's answer as its info reports it.
import { create } from "@bufbuild/protobuf";
import { ApprovalItemSchema, MacFolderAccess, MachineInfoSchema, PromptState, ToolKind } from "@achoo254/chat-proto/remote/remote";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { ApprovalCard } from "../../src/machines/cards/approval.tsx";
import type { LinkState } from "../../src/machines/link/machine-link.ts";
import { MacFolderAccessDialog, folderLabel } from "../../src/machines/mac-folder-access.tsx";

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
