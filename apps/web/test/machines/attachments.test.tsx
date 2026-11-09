// Files with a message to the AI on a machine: limits checked on the device,
// pieces uploaded in order over the machine's link with progress and cancel,
// paste, drop and the attach button feeding the composer's tray, removing a
// file, a machine too old to take files, and the files of a sent message in
// the thread (images fetched again from the machine).
import { ErrorCode, ErrorReason, Role, type Frame, type Item } from "@achoo254/chat-proto/remote/remote";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { fitScale, renamed } from "../../src/machines/attachment-image.ts";
import { MessageAttachments, useFileDrop } from "../../src/machines/attachment-tray.tsx";
import { admit, UploadCancelled, uploadFile, type Limits, type UploadLink } from "../../src/machines/attachments.ts";
import { Composer } from "../../src/machines/composer.tsx";
import { RemoteError } from "../../src/machines/link/machine-link.ts";
import { machineErrorText } from "../../src/machines/machine-errors.ts";
import { viMachines } from "../../src/machines/copy-vi.ts";
import { foldTranscript, type ShownAttachment } from "../../src/machines/transcript/tool-fold.ts";
import { useAttachments } from "../../src/machines/use-attachments.ts";

const wrap = (node: ReactNode) => render(<I18nProvider>{node}</I18nProvider>);

const LIMITS: Limits = { fileMaxBytes: 1000, messageMaxBytes: 1500, messageMaxFiles: 3, imageMaxBytes: 600, pieceMaxBytes: 4 };

type Req = Parameters<UploadLink["request"]>[0];

/** A link that records requests; `answer` decides each one (resolves by default). */
function fakeLink(answer: (req: Req) => Promise<Frame> = () => Promise.resolve({} as Frame)) {
	const sent: Req[] = [];
	const link: UploadLink & { send?: unknown } = {
		request: (req) => {
			sent.push(req);
			return answer(req);
		},
	};
	return { link, sent };
}

const file = (name: string, size: number, type = "text/plain") => new File([new Uint8Array(size).fill(65)], name, { type });

describe("limits on the device", () => {
	it("refuses a file over the limit by name, and stops at the count and the total of a message", () => {
		const r = admit([{ size: 100 }], [{ name: "big.zip", size: 1001 }, { name: "a", size: 900 }, { name: "b", size: 600 }, { name: "c", size: 1 }, { name: "d", size: 1 }], LIMITS);
		expect(r.accepted.map((f) => f.name)).toEqual(["a", "c"]);
		expect(r.refused).toEqual([{ kind: "too-large", name: "big.zip" }, { kind: "total-too-large" }, { kind: "too-many" }]);
	});
});

describe("upload", () => {
	it("sends pieces in order, the first naming the file, and reports progress", async () => {
		const { link, sent } = fakeLink();
		const progress: number[] = [];
		await uploadFile(link, { threadId: "t1", uploadId: "u-1", file: file("notes.txt", 10), pieceBytes: 4, signal: new AbortController().signal, onProgress: (n) => progress.push(n) });
		const pieces = sent.flatMap((r) => (r.case === "attachmentUpload" ? [r.value] : []));
		expect(pieces.map((p) => [Number(p.offset), p.data?.length, p.name, Number(p.size), p.threadId])).toEqual([
			[0, 4, "notes.txt", 10, "t1"],
			[4, 4, "", 0, ""],
			[8, 2, "", 0, ""],
		]);
		expect(progress.at(-1)).toBe(10);
	});

	it("drops what the machine got when cancelled", async () => {
		const controller = new AbortController();
		const { link, sent } = fakeLink(async (req) => {
			if (req.case === "attachmentUpload" && Number(req.value.offset) === 4) controller.abort();
			return {} as Frame;
		});
		await expect(uploadFile(link, { threadId: "t", uploadId: "u-2", file: file("a.bin", 12), pieceBytes: 4, signal: controller.signal, onProgress: () => undefined })).rejects.toBeInstanceOf(UploadCancelled);
		expect(sent.at(-1)).toEqual({ case: "attachmentCancel", value: { uploadId: "u-2" } });
	});

	it("passes the machine's refusal on", async () => {
		const refusal = new RemoteError(ErrorCode.INVALID, "too large", ErrorReason.ATTACHMENT_TOO_LARGE, "a.bin");
		const { link } = fakeLink(() => Promise.reject(refusal));
		await expect(uploadFile(link, { threadId: "t", uploadId: "u-3", file: file("a.bin", 3), pieceBytes: 4, signal: new AbortController().signal, onProgress: () => undefined })).rejects.toBe(refusal);
		expect(machineErrorText(viMachines, refusal, "Claude Code")).toBe("Tệp “a.bin” quá lớn để gửi tới máy.");
		expect(machineErrorText(viMachines, new RemoteError(ErrorCode.INVALID, "", ErrorReason.ATTACHMENT_NOT_FOUND), "")).toContain("Đính kèm lại");
		expect(machineErrorText(viMachines, new RemoteError(ErrorCode.INVALID, "", ErrorReason.TOO_MANY_ATTACHMENTS), "")).toContain("Quá nhiều tệp");
	});
});

describe("images", () => {
	it("fits the longest side and renames for the new type", () => {
		expect(fitScale(4000, 3000, 2000)).toBe(0.5);
		expect(fitScale(800, 600, 2000)).toBe(1);
		expect(renamed("IMG_0001.HEIC", "image/jpeg")).toBe("IMG_0001.jpg");
		expect(renamed("shot.png", "image/webp")).toBe("shot.webp");
	});
});

/** A session composer with its tray, as the session screen wires them. */
function Session({ link, limits, images = true, onSend }: { link: UploadLink; limits: Limits | null; images?: boolean; onSend: (text: string, files: readonly ShownAttachment[]) => Promise<void> }) {
	const attach = useAttachments(link, "t1", limits, images, "Claude Code");
	const drop = useFileDrop(true, attach.add);
	return (
		<div data-testid="session" {...drop.handlers}>
			{drop.dragging && <p>đang kéo</p>}
			<Composer ai="Claude Code" machine="Mac" online running={false} prompting={false} commands={[]} attach={attach} onSend={onSend} onStop={() => Promise.resolve()} />
		</div>
	);
}

const field = () => screen.getByRole("textbox", { name: "Tin nhắn" }) as HTMLTextAreaElement;
const paste = (files: File[], text = "") =>
	fireEvent.paste(field(), { clipboardData: { files, getData: (type: string) => (type === "text/plain" ? text : "") } });

describe("the composer's files", () => {
	it("takes a pasted file, uploads it and sends it with no text", async () => {
		const { link, sent } = fakeLink();
		const onSend = vi.fn((_text: string, _files: readonly ShownAttachment[]) => Promise.resolve());
		wrap(<Session link={link} limits={LIMITS} onSend={onSend} />);
		paste([file("log.txt", 6)]);
		expect(await screen.findByText("log.txt")).toBeTruthy();
		const send = screen.getByRole("button", { name: "Gửi" }) as HTMLButtonElement;
		await waitFor(() => expect(send.disabled).toBe(false));
		expect(sent.filter((r) => r.case === "attachmentUpload")).toHaveLength(2);
		await userEvent.click(send);
		expect(onSend).toHaveBeenCalledTimes(1);
		const [text, files] = onSend.mock.calls[0] ?? [];
		expect(text).toBe("");
		expect(files?.map((f) => [f.name, f.size, f.image])).toEqual([["log.txt", 6, false]]);
		expect(screen.queryByText("log.txt")).toBeNull();
	});

	it("leaves pasted text alone even when the clipboard also carries a file", () => {
		const { link, sent } = fakeLink();
		wrap(<Session link={link} limits={LIMITS} onSend={() => Promise.resolve()} />);
		paste([file("cell.png", 3, "image/png")], "A1");
		expect(sent).toHaveLength(0);
		expect(screen.queryByRole("group", { name: "Tệp đính kèm" })).toBeNull();
	});

	it("takes files dropped anywhere on the session, showing the drop zone while dragging", async () => {
		const { link } = fakeLink();
		wrap(<Session link={link} limits={LIMITS} onSend={() => Promise.resolve()} />);
		const area = screen.getByTestId("session");
		const dataTransfer = { types: ["Files"], files: [file("spec.pdf", 5, "application/pdf")], dropEffect: "" };
		fireEvent.dragEnter(area, { dataTransfer });
		expect(screen.getByText("đang kéo")).toBeTruthy();
		fireEvent.drop(area, { dataTransfer });
		expect(screen.queryByText("đang kéo")).toBeNull();
		expect(await screen.findByText("spec.pdf")).toBeTruthy();
	});

	it("adds picked files through the attach menu", async () => {
		const { link } = fakeLink();
		wrap(<Session link={link} limits={LIMITS} onSend={() => Promise.resolve()} />);
		await userEvent.click(screen.getByRole("button", { name: "Đính kèm ảnh hoặc tệp" }));
		expect(screen.getByRole("menuitem", { name: "Tệp" })).toBeTruthy();
		await userEvent.upload(screen.getByTestId("attach-files"), file("data.csv", 3, "text/csv"));
		expect(await screen.findByText("data.csv")).toBeTruthy();
	});

	it("on a phone, pastes a copied image from the attach menu, and says when none was copied", async () => {
		vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(pointer: coarse)" }));
		const image = { types: ["text/html", "image/png"], getType: () => Promise.resolve(new Blob([new Uint8Array(3)], { type: "image/png" })) };
		const read = vi.fn().mockResolvedValueOnce([image]).mockResolvedValueOnce([{ types: ["text/plain"], getType: vi.fn() }]);
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { read } });
		try {
			const { link } = fakeLink();
			wrap(<Session link={link} limits={LIMITS} onSend={() => Promise.resolve()} />);
			const menu = screen.getByRole("button", { name: "Đính kèm ảnh hoặc tệp" });
			await userEvent.click(menu);
			await userEvent.click(screen.getByRole("menuitem", { name: "Dán ảnh đã sao chép" }));
			expect(await screen.findByText("image.png")).toBeTruthy();
			await userEvent.click(menu);
			await userEvent.click(screen.getByRole("menuitem", { name: "Dán ảnh đã sao chép" }));
			expect(await screen.findByText(viMachines.agent.attach.pasteEmpty)).toBeTruthy();
		} finally {
			vi.unstubAllGlobals();
			Reflect.deleteProperty(navigator, "clipboard");
		}
	});

	it("offers no paste item where the pointer is a mouse", async () => {
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { read: vi.fn() } });
		try {
			const { link } = fakeLink();
			wrap(<Session link={link} limits={LIMITS} onSend={() => Promise.resolve()} />);
			await userEvent.click(screen.getByRole("button", { name: "Đính kèm ảnh hoặc tệp" }));
			expect(screen.queryByRole("menuitem", { name: "Dán ảnh đã sao chép" })).toBeNull();
		} finally {
			Reflect.deleteProperty(navigator, "clipboard");
		}
	});

	it("removes a file and drops its upload on the machine", async () => {
		const { link, sent } = fakeLink();
		wrap(<Session link={link} limits={LIMITS} onSend={() => Promise.resolve()} />);
		paste([file("a.txt", 2)]);
		await waitFor(() => expect((screen.getByRole("button", { name: "Gửi" }) as HTMLButtonElement).disabled).toBe(false));
		await userEvent.click(screen.getByRole("button", { name: "Gỡ a.txt" }));
		expect(screen.queryByText("a.txt")).toBeNull();
		expect(sent.at(-1)?.case).toBe("attachmentCancel");
		expect((screen.getByRole("button", { name: "Gửi" }) as HTMLButtonElement).disabled).toBe(true);
	});

	it("says what was too large and keeps the rest", async () => {
		const { link } = fakeLink();
		wrap(<Session link={link} limits={LIMITS} onSend={() => Promise.resolve()} />);
		paste([file("huge.iso", 1001), file("ok.txt", 2)]);
		expect((await screen.findByRole("alert")).textContent).toContain("“huge.iso” lớn hơn");
		expect(screen.getByText("ok.txt")).toBeTruthy();
		expect(screen.queryByText("huge.iso")).toBeNull();
	});

	it("shows an upload the machine refused, with try again", async () => {
		let fail = true;
		const { link } = fakeLink(() => (fail ? Promise.reject(new RemoteError(ErrorCode.INVALID, "", ErrorReason.TOO_MANY_ATTACHMENTS)) : Promise.resolve({} as Frame)));
		wrap(<Session link={link} limits={LIMITS} onSend={() => Promise.resolve()} />);
		paste([file("a.txt", 2)]);
		expect(await screen.findByText(/Quá nhiều tệp/)).toBeTruthy();
		expect((screen.getByRole("button", { name: "Gửi" }) as HTMLButtonElement).disabled).toBe(true);
		fail = false;
		await userEvent.click(screen.getByRole("button", { name: "Thử lại" }));
		await waitFor(() => expect((screen.getByRole("button", { name: "Gửi" }) as HTMLButtonElement).disabled).toBe(false));
	});

	it("puts the files back when the message fails, uploading them again", async () => {
		const { link, sent } = fakeLink();
		const onSend = vi.fn(() => Promise.reject(new Error("offline")));
		wrap(<Session link={link} limits={LIMITS} onSend={onSend} />);
		paste([file("a.txt", 2)]);
		await waitFor(() => expect((screen.getByRole("button", { name: "Gửi" }) as HTMLButtonElement).disabled).toBe(false));
		await userEvent.click(screen.getByRole("button", { name: "Gửi" }));
		expect(await screen.findByText("a.txt")).toBeTruthy();
		await waitFor(() => expect(sent.filter((r) => r.case === "attachmentUpload")).toHaveLength(2));
	});

	it("on a machine too old for files: no attach button, and a pasted file says to update", async () => {
		const { link, sent } = fakeLink();
		wrap(<Session link={link} limits={null} onSend={() => Promise.resolve()} />);
		expect(screen.queryByRole("button", { name: "Đính kèm ảnh hoặc tệp" })).toBeNull();
		paste([file("a.txt", 2)]);
		expect((await screen.findByRole("alert")).textContent).toContain("tunelo update");
		expect(sent).toHaveLength(0);
	});
});

describe("files of a sent message", () => {
	const userItem = (attachments: object[]): Item =>
		({ id: "user:1", seq: 1n, revision: 1, at: 0n, provider: "claude", model: "", body: { case: "text", value: { role: Role.USER, text: "xem giúp", partial: false, clientMsgId: "", attachments } } }) as unknown as Item;

	it("folds them into the user message", () => {
		const blocks = foldTranscript([userItem([{ id: "img-1", name: "a.png", mimeType: "image/png", size: 10n, image: true, path: "" }])]);
		expect(blocks[0]).toMatchObject({ kind: "user", attachments: [{ id: "img-1", name: "a.png", size: 10, image: true, path: "", preview: "" }] });
	});

	it("fetches an image from the machine and names where a file was saved", async () => {
		const { link, sent } = fakeLink(async (req) =>
			req.case === "attachmentFetch"
				? ({ body: { case: "attachmentData", value: { threadId: "t9", attachmentId: req.value.attachmentId, mimeType: "image/png", data: new Uint8Array([1, 2]) } } } as unknown as Frame)
				: ({} as Frame),
		);
		const files: ShownAttachment[] = [
			{ id: "img-9", name: "a.png", size: 2, image: true, path: "", preview: "" },
			{ id: "f-9", name: "spec.pdf", size: 5, image: false, path: ".tunelo-attachments/2026-11-09/spec.pdf", preview: "" },
		];
		await act(async () => {
			wrap(<MessageAttachments link={link} threadId="t9" files={files} />);
		});
		expect(await screen.findByRole("img", { name: "a.png" })).toBeTruthy();
		expect(sent).toEqual([{ case: "attachmentFetch", value: { threadId: "t9", attachmentId: "img-9" } }]);
		expect(screen.getByText(".tunelo-attachments/2026-11-09/spec.pdf")).toBeTruthy();
	});
});
