// The approval card of a tool acting as the user (ApprovalItem.write): a
// message into a chat, a Localman request, a tunnel. The card words it in the
// user's language and names the chat as this device knows it; a machine that
// sends no `write` (older tunelo) keeps its English summary and reason.
import { create } from "@bufbuild/protobuf";
import { ApprovalItemSchema, ApprovalWriteSchema, PromptState, ToolKind, type ApprovalWrite } from "@achoo254/chat-proto/remote/remote";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { ApprovalCard, fileProblem, writeWords } from "../../src/machines/cards/approval.tsx";
import { enMachines } from "../../src/machines/copy-en.ts";
import { viMachines } from "../../src/machines/copy-vi.ts";
import { zhCNMachines } from "../../src/machines/copy-zh-CN.ts";
import { ServicesContext, type Services } from "../../src/messaging/data/services.tsx";

const SUMMARY = "Send to Đạt Trịnh Quốc Hoàn (2 members): hello";
const REASON = "It acts as you in Chat, Localman or on the internet: tunelo asks you every time.";

const send = (fields: Partial<Omit<ApprovalWrite, "$typeName">> = {}): ApprovalWrite =>
	create(ApprovalWriteSchema, { tool: "chat_send_message", chatId: 48n, chatTitle: "Nhóm dự án", chatMembers: 5, text: "Mai họp lúc 9 giờ", textLength: 17, ...fields });

const approval = (write: ApprovalWrite | undefined, input = '{"chat_id":48,"text":"Mai họp lúc 9 giờ"}') =>
	create(ApprovalItemSchema, {
		toolId: "t1",
		kind: ToolKind.MCP,
		name: "mcp__tunelo__chat_send_message",
		input,
		summary: SUMMARY,
		reason: REASON,
		state: PromptState.PENDING,
		...(write === undefined ? {} : { write }),
	});

describe("the words of a tool acting as the user", () => {
	it("says where a message goes, in every language", () => {
		expect(writeWords(viMachines, send(), "")).toEqual({ summary: "Gửi vào «Nhóm dự án» (5 thành viên): Mai họp lúc 9 giờ", reason: viMachines.approval.write.reason });
		expect(writeWords(enMachines, send(), "").summary).toBe("Send to «Nhóm dự án» (5 members): Mai họp lúc 9 giờ");
		expect(writeWords(zhCNMachines, send(), "").summary).toBe("发送到「Nhóm dự án」（5 名成员）：Mai họp lúc 9 giờ");
		// A one-to-one chat (no member count), named as this device knows it.
		expect(writeWords(viMachines, send({ chatMembers: 0 }), "Lan").summary).toBe("Gửi vào «Lan»: Mai họp lúc 9 giờ");
		expect(writeWords(enMachines, send({ chatMembers: 0 }), "Lan").summary).toBe("Send to «Lan»: Mai họp lúc 9 giờ");
		expect(writeWords(zhCNMachines, send({ chatMembers: 0 }), "Lan").summary).toBe("发送到「Lan」：Mai họp lúc 9 giờ");
		// No name at all: the chat's id.
		expect(writeWords(viMachines, send({ chatTitle: "", chatMembers: 0 }), "").summary).toBe("Gửi vào cuộc trò chuyện 48: Mai họp lúc 9 giờ");
		expect(writeWords(enMachines, send({ chatTitle: "", chatMembers: 0 }), "").summary).toBe("Send to chat 48: Mai họp lúc 9 giờ");
		expect(writeWords(zhCNMachines, send({ chatTitle: "", chatMembers: 0 }), "").summary).toBe("发送到聊天 48：Mai họp lúc 9 giờ");
	});

	it("gives the whole length of a longer message", () => {
		const long = send({ chatMembers: 0, text: "Chào", textLength: 320 });
		expect(writeWords(viMachines, long, "").summary).toBe("Gửi vào «Nhóm dự án»: Chào… (320 ký tự)");
		expect(writeWords(enMachines, long, "").summary).toBe("Send to «Nhóm dự án»: Chào… (320 characters)");
		expect(writeWords(zhCNMachines, long, "").summary).toBe("发送到「Nhóm dự án」：Chào…（共 320 个字符）");
	});

	it("shows a Localman request as method and URL, and words only the reason of other tools", () => {
		const request = create(ApprovalWriteSchema, { tool: "localman_send_request", method: "POST", url: "https://api.example.com/v1/items" });
		for (const t of [viMachines, enMachines, zhCNMachines]) expect(writeWords(t, request, "")).toEqual({ summary: "POST https://api.example.com/v1/items", reason: t.approval.write.reason });
		const tunnel = create(ApprovalWriteSchema, { tool: "open_http_tunnel" });
		expect(writeWords(zhCNMachines, tunnel, "")).toEqual({ summary: null, reason: "此操作会以你的身份在 Chat、Localman 或互联网上执行：tunelo 每次都会询问你。" });
		expect(writeWords(enMachines, tunnel, "").reason).toBe(REASON);
	});
});

describe("the approval card", () => {
	it("words a message in the user's language, the chat named as the chat list shows it, the tool and input untouched", () => {
		const store = {
			subscribe: () => () => undefined,
			dialog: (chatId: number) => (chatId === 48 ? { chat: { type: "group", title: "Dự án Chat" }, peer: null } : undefined),
		};
		render(
			<I18nProvider>
				<ServicesContext value={{ store, self: { id: 1, name: "Tôi" } } as unknown as Services}>
					<ApprovalCard approval={approval(send())} ai="Claude" sessionAllow={false} onDecide={async () => undefined} />
				</ServicesContext>
			</I18nProvider>,
		);
		expect(screen.getByText("Gửi vào «Dự án Chat» (5 thành viên): Mai họp lúc 9 giờ")).toBeTruthy();
		expect(screen.getByText(viMachines.approval.write.reason)).toBeTruthy();
		expect(screen.getByText("Cho phép dùng mcp__tunelo__chat_send_message?")).toBeTruthy();
		expect(screen.queryByText(SUMMARY)).toBeNull();
		expect(screen.queryByText(REASON)).toBeNull();
	});

	it("keeps the machine's summary and reason when it sends no write (an older tunelo)", () => {
		render(
			<I18nProvider>
				<ApprovalCard approval={approval(undefined)} ai="Claude" sessionAllow={false} onDecide={async () => undefined} />
			</I18nProvider>,
		);
		expect(screen.getByText(SUMMARY)).toBeTruthy();
		expect(screen.getByText(REASON)).toBeTruthy();
	});
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const sendFile = (fields: Partial<Omit<ApprovalWrite, "$typeName">> = {}): ApprovalWrite =>
	create(ApprovalWriteSchema, {
		tool: "chat_send_file",
		chatId: 48n,
		chatTitle: "Nhóm dự án",
		chatMembers: 5,
		text: "Ảnh chụp màn hình",
		textLength: 17,
		files: [
			{ name: "man-hinh.png", size: 2048n, mime: "image/png", preview: PNG },
			{ name: "bao-cao.pdf", size: 1_572_864n, mime: "application/pdf" },
			{ name: "id_rsa", size: 0n, mime: "application/octet-stream", problem: "in a sensitive folder" },
			{ name: "la.bin", size: 0n, mime: "application/octet-stream", problem: "too large for Chat" },
		],
		...fields,
	});

describe("files of the machine sent to a chat", () => {
	afterEach(() => vi.restoreAllMocks());

	it("says how many files go where, with the caption, in every language", () => {
		expect(writeWords(viMachines, sendFile(), "").summary).toBe("Gửi 4 tệp vào «Nhóm dự án» (5 thành viên): Ảnh chụp màn hình");
		expect(writeWords(enMachines, sendFile(), "").summary).toBe("Send 4 files to «Nhóm dự án» (5 members): Ảnh chụp màn hình");
		expect(writeWords(zhCNMachines, sendFile(), "").summary).toBe("发送 4 个文件到「Nhóm dự án」（5 名成员）：Ảnh chụp màn hình");
		// No caption, a one-to-one chat named as this device knows it; a long caption gets its length.
		const bare = sendFile({ text: "", textLength: 0, chatMembers: 0 });
		expect(writeWords(viMachines, bare, "Lan").summary).toBe("Gửi 4 tệp vào «Lan»");
		expect(writeWords(enMachines, sendFile({ chatMembers: 0, text: "Chào", textLength: 300 }), "").summary).toBe("Send 4 files to «Nhóm dự án»: Chào… (300 characters)");
		expect(writeWords(zhCNMachines, sendFile({ chatTitle: "", chatMembers: 0, text: "" , textLength: 0}), "").summary).toBe("发送 4 个文件到聊天 48");
	});

	it("words the other chat writes from the call's own arguments", () => {
		const media = create(ApprovalWriteSchema, { tool: "chat_send_media" });
		expect(writeWords(viMachines, media, "Lan", '{"chat_id":48,"media_ids":["a","b"]}').summary).toBe("Gửi 2 tệp vào «Lan»");
		expect(writeWords(enMachines, media, "", '{"chat_id":48,"media_ids":["a"]}').summary).toBe("Send 1 file to chat 48");
		expect(writeWords(zhCNMachines, media, "Lan", '{"chat_id":48}').summary).toBe("将 Chat 中已有的图片或文件发送到「Lan」");
		expect(writeWords(viMachines, media, "Lan", '{"chat_id":48}').summary).toBe("Gửi ảnh/tệp đã có trong Chat vào «Lan»");
		const forward = create(ApprovalWriteSchema, { tool: "chat_forward_messages" });
		expect(writeWords(viMachines, forward, "Nhóm", '{"from_chat_id":7,"seqs":[1],"to_chat_id":48}').summary).toBe("Chuyển tiếp tin tới «Nhóm»");
		expect(writeWords(enMachines, forward, "", '{"from_chat_id":7,"seqs":[1],"to_chat_id":48}').summary).toBe("Forward messages to chat 48");
		expect(writeWords(zhCNMachines, forward, "Nhóm", "{}").summary).toBe("转发消息到「Nhóm」");
		const open = create(ApprovalWriteSchema, { tool: "chat_start_private_chat" });
		expect(writeWords(viMachines, open, "", '{"user_id":77}').summary).toBe("Mở chat riêng với người dùng 77");
		expect(writeWords(enMachines, open, "", '{"user_id":77}').summary).toBe("Open a private chat with user 77");
		expect(writeWords(zhCNMachines, open, "", "not json").summary).toBe("与用户 ? 开始私聊");
	});

	it("translates the six reasons a file cannot be sent, and shows any other as it came", () => {
		const reasons = ["outside the session's folder", "a path with .. is not allowed", "not a regular file", "not found", "in a sensitive folder", "the session's folder is gone"];
		expect(reasons.map((r) => fileProblem(viMachines, r))).toEqual([
			"nằm ngoài thư mục của phiên",
			"không được dùng đường dẫn có ..",
			"không phải tệp thường",
			"không tìm thấy",
			"nằm trong thư mục nhạy cảm",
			"thư mục của phiên không còn",
		]);
		expect(reasons.map((r) => fileProblem(enMachines, r))).toEqual(reasons);
		expect(fileProblem(zhCNMachines, "not found")).toBe("找不到");
		expect(fileProblem(viMachines, "too large for Chat")).toBe("too large for Chat");
	});

	it("shows a thumbnail for a photo, an icon and size for other files, and the files that will not go in red", () => {
		const made: Blob[] = [];
		const create_ = vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
			made.push(blob as Blob);
			return "blob:preview-1";
		});
		const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
		const { unmount } = render(
			<I18nProvider>
				<ApprovalCard approval={approval(sendFile(), '{"chat_id":48,"paths":["man-hinh.png"]}')} ai="Claude" sessionAllow={false} onDecide={async () => undefined} />
			</I18nProvider>,
		);
		expect(screen.getByText("Gửi 4 tệp vào «Nhóm dự án» (5 thành viên): Ảnh chụp màn hình")).toBeTruthy();
		const rows = within(screen.getByRole("list", { name: "Tệp sẽ gửi" })).getAllByRole("listitem");
		expect(rows).toHaveLength(4);
		const [photo, pdf, secret, unknown] = rows as [HTMLElement, HTMLElement, HTMLElement, HTMLElement];
		expect(within(photo).getByRole("img", { name: "man-hinh.png" }).getAttribute("src")).toBe("blob:preview-1");
		expect(made[0]?.type).toBe("image/png");
		expect(create_).toHaveBeenCalledTimes(1);
		expect(pdf.querySelector("img")).toBeNull();
		expect(pdf.querySelector("svg")).not.toBeNull();
		expect(within(pdf).getByText("1,5 MB")).toBeTruthy();
		expect(secret.classList.contains("bad")).toBe(true);
		expect(within(secret).getByRole("alert").textContent).toBe("không gửi được: nằm trong thư mục nhạy cảm");
		expect(within(unknown).getByRole("alert").textContent).toBe("không gửi được: too large for Chat");
		unmount();
		expect(revoke).toHaveBeenCalledWith("blob:preview-1");
	});

	it("lists no files from a machine that sends none (an older tunelo)", () => {
		render(
			<I18nProvider>
				<ApprovalCard approval={approval(sendFile({ files: [] }))} ai="Claude" sessionAllow={false} onDecide={async () => undefined} />
			</I18nProvider>,
		);
		expect(screen.queryByRole("list", { name: "Tệp sẽ gửi" })).toBeNull();
		// Its own English line stays; the reason is worded here.
		expect(screen.getByText(SUMMARY)).toBeTruthy();
		expect(screen.getByText(viMachines.approval.write.reason)).toBeTruthy();
	});
});

describe("the user's chat with themselves", () => {
	const self = { id: 1, name: "Đạt Trịnh Quốc Hoàn" };
	const toSelf = create(ApprovalWriteSchema, { tool: "chat_send_message", chatId: 99n, chatTitle: self.name, chatMembers: 0, text: "ghi chú", textLength: 7 });
	const cardWith = (store: unknown) =>
		render(
			<I18nProvider>
				<ServicesContext value={{ store, self } as unknown as Services}>
					<ApprovalCard approval={approval(toSelf, '{"chat_id":99,"text":"ghi chú"}')} ai="Claude" sessionAllow={false} onDecide={async () => undefined} />
				</ServicesContext>
			</I18nProvider>,
		);

	it("is named as the chat list names it, not after the user", () => {
		const store = {
			subscribe: () => () => undefined,
			dialog: (chatId: number) => (chatId === 99 ? { chat: { type: "private", title: "", memberCount: 1 }, peer: { id: 1, name: self.name, isSelf: true } } : undefined),
		};
		cardWith(store);
		expect(screen.getByText("Gửi vào «Cloud của tôi»: ghi chú")).toBeTruthy();
		expect(screen.queryByText(/Đạt Trịnh Quốc Hoàn/)).toBeNull();
	});

	it("is recognised from the machine's name for it when this device does not know the chat", () => {
		cardWith({ subscribe: () => () => undefined, dialog: () => undefined });
		expect(screen.getByText("Gửi vào «Cloud của tôi»: ghi chú")).toBeTruthy();
		expect([viMachines, enMachines, zhCNMachines].map((t) => t.approval.write.savedChat)).toEqual(["Cloud của tôi", "My Cloud", "我的云端"]);
	});
});
