// Archiving and deleting a session from a device: the dialog says the files
// go to the machine's Trash, asks again for a running session or one open
// elsewhere, and old machines offer neither.
import { ErrorCode, ErrorReason, type Frame, type MachineInfo } from "@achoo254/chat-proto/remote/remote";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { RemoteError } from "../../src/machines/link/machine-link.ts";
import { DeleteThreadDialog, ThreadMenuItems, threadActionsSupported } from "../../src/machines/thread-actions.tsx";

const wrap = (node: ReactNode) => render(<I18nProvider>{node}</I18nProvider>);
type Req = Parameters<Parameters<typeof DeleteThreadDialog>[0]["link"]["request"]>[0];

function fakeLink(answer: (req: Req, n: number) => Promise<Frame>) {
	const sent: Req[] = [];
	return { sent, link: { request: (req: Req) => (sent.push(req), answer(req, sent.length)) } };
}
const refuse = (reason: ErrorReason) => Promise.reject(new RemoteError(ErrorCode.INVALID, "", reason));

describe("deleting a session", () => {
	it("says the files go to the Trash on the machine, then deletes", async () => {
		const { link, sent } = fakeLink(() => Promise.resolve({} as Frame));
		const onDeleted = vi.fn();
		wrap(<DeleteThreadDialog link={link} thread={{ id: "t1", title: "Sửa CSS" }} machine="Mac mini" ai="Claude Code" onClose={() => undefined} onDeleted={onDeleted} />);
		expect(screen.getByText(/Thùng rác trên Mac mini, khôi phục được từ Thùng rác/)).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Xoá phiên" }));
		await waitFor(() => expect(onDeleted).toHaveBeenCalled());
		expect(sent).toEqual([{ case: "threadDelete", value: { threadId: "t1", stopRunning: false, openAnyway: false } }]);
	});

	it("asks to stop a running session, then a session open elsewhere, and keeps both answers", async () => {
		const { link, sent } = fakeLink((_req, n) => (n === 1 ? refuse(ErrorReason.THREAD_RUNNING) : n === 2 ? refuse(ErrorReason.SESSION_OPEN_ELSEWHERE) : Promise.resolve({} as Frame)));
		const onDeleted = vi.fn();
		wrap(<DeleteThreadDialog link={link} thread={{ id: "t1", title: "x" }} machine="Mac" ai="Claude Code" onClose={() => undefined} onDeleted={onDeleted} />);
		await userEvent.click(screen.getByRole("button", { name: "Xoá phiên" }));
		expect((await screen.findByRole("alert")).textContent).toContain("đang chạy một lượt");
		await userEvent.click(screen.getByRole("button", { name: "Dừng và xoá" }));
		expect((await screen.findByRole("alert")).textContent).toContain("đang mở ở nơi khác");
		await userEvent.click(screen.getByRole("button", { name: "Vẫn xoá" }));
		await waitFor(() => expect(onDeleted).toHaveBeenCalled());
		expect(sent.map((r) => (r.case === "threadDelete" ? [r.value.stopRunning, r.value.openAnyway] : []))).toEqual([
			[false, false],
			[true, false],
			[true, true],
		]);
	});

	it("says when the machine's Trash refused, and deletes nothing", async () => {
		const { link } = fakeLink(() => Promise.reject(new RemoteError(ErrorCode.INTERNAL, "", ErrorReason.TRASH_UNAVAILABLE, "no trash")));
		const onDeleted = vi.fn();
		wrap(<DeleteThreadDialog link={link} thread={{ id: "t1", title: "x" }} machine="Mac" ai="Claude Code" onClose={() => undefined} onDeleted={onDeleted} />);
		await userEvent.click(screen.getByRole("button", { name: "Xoá phiên" }));
		expect((await screen.findByRole("alert")).textContent).toContain("chưa xoá gì: no trash");
		expect(onDeleted).not.toHaveBeenCalled();
	});
});

describe("archiving", () => {
	it("archives and unarchives through the menu", async () => {
		const { link, sent } = fakeLink(() => Promise.resolve({} as Frame));
		const { rerender } = wrap(<ThreadMenuItems link={link} thread={{ id: "t1", archived: false }} onDelete={() => undefined} onDone={() => undefined} />);
		await userEvent.click(screen.getByRole("menuitem", { name: "Lưu trữ" }));
		rerender(
			<I18nProvider>
				<ThreadMenuItems link={link} thread={{ id: "t1", archived: true }} onDelete={() => undefined} onDone={() => undefined} />
			</I18nProvider>,
		);
		await userEvent.click(screen.getByRole("menuitem", { name: "Bỏ lưu trữ" }));
		expect(sent).toEqual([
			{ case: "threadSetArchived", value: { threadId: "t1", archived: true } },
			{ case: "threadSetArchived", value: { threadId: "t1", archived: false } },
		]);
	});

	it("is offered only by tunelo 2.0.6 and later", () => {
		const info = (agentVersion: string) => ({ agentVersion }) as MachineInfo;
		expect(threadActionsSupported(info("2.0.5"))).toBe(false);
		expect(threadActionsSupported(info("2.0.6"))).toBe(true);
		expect(threadActionsSupported(null)).toBe(false);
	});
});
