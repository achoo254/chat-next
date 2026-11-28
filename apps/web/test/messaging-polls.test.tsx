// Polls through the real client core and the in-memory server: a poll arrives in
// a group, the user votes on a single-answer poll with one click and sees the
// results, takes the vote back, votes on a multiple-answer poll with "Bình chọn",
// stops their own poll with two clicks, and posts one from the attach menu.
import { ChatType } from "@achoo254/chat-proto/chats";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { pollDraft } from "../src/messaging/ui/poll-dialog.tsx";
import { pollPercent } from "../src/messaging/ui/poll-view.tsx";
import { ChatFixture } from "./support/fake-chat.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const LONG = { timeout: 8000 };

function setup() {
	const f = new ChatFixture();
	const lan = f.addUser("Lan Anh", { username: "lananh" });
	const minh = f.addUser("Minh", { username: "minh" });
	const chat = f.createChat(ChatType.GROUP, "Ăn trưa", [f.selfId, lan, minh]);
	f.enableMedia();
	f.send(lan, chat, "Trưa nay ăn gì?");
	return { f, lan, minh, chat };
}

async function open(f: ChatFixture, chat: number) {
	renderMessaging(f, `/c/${chat}`);
	const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
	await within(log).findByText("Trưa nay ăn gì?", {}, LONG);
	return log;
}

describe("polls", () => {
	it("votes with one click, shows the results, and takes the vote back", async () => {
		const { f, lan, minh, chat } = setup();
		const { seq } = f.server.sendMessage(lan, chat, "", 0, { poll: { question: "Món nào?", options: ["Phở", "Bún", "Cơm"] } });
		f.server.votePoll(minh, chat, seq, [1]);
		const log = await open(f, chat);
		const poll = await within(log).findByText("Món nào?", {}, LONG);
		const box = poll.closest<HTMLElement>(".poll");
		if (box === null) throw new Error("no poll");
		expect(within(box).getByText("Bình chọn ẩn danh")).toBeTruthy();
		expect(within(box).getByText("1 người đã bình chọn")).toBeTruthy();

		await userEvent.click(within(box).getByRole("button", { name: "Phở" }));
		await within(box).findByLabelText("Phở: 1 phiếu, 50%, bạn đã chọn", {}, LONG);
		expect(within(box).getByLabelText("Bún: 1 phiếu, 50%")).toBeTruthy();
		expect(f.pollVotes).toEqual([{ chatId: chat, seq, options: [0] }]);

		await userEvent.click(within(box).getByRole("button", { name: "Rút phiếu" }));
		await within(box).findByRole("button", { name: "Phở" }, LONG);
		expect(f.pollVotes.at(-1)).toEqual({ chatId: chat, seq, options: [] });
	});

	it("takes the ticked answers of a multiple-answer poll with Bình chọn", async () => {
		const { f, lan, chat } = setup();
		const { seq } = f.server.sendMessage(lan, chat, "", 0, { poll: { question: "Đi đâu?", options: ["Biển", "Núi", "Phố"], multiple: true } });
		const log = await open(f, chat);
		const box = (await within(log).findByText("Đi đâu?", {}, LONG)).closest<HTMLElement>(".poll");
		if (box === null) throw new Error("no poll");
		const vote = within(box).getByRole("button", { name: "Bình chọn" });
		expect((vote as HTMLButtonElement).disabled).toBe(true);
		await userEvent.click(within(box).getByRole("checkbox", { name: "Phố" }));
		await userEvent.click(within(box).getByRole("checkbox", { name: "Biển" }));
		await userEvent.click(vote);
		await waitFor(() => expect(f.pollVotes).toEqual([{ chatId: chat, seq, options: [0, 2] }]), LONG);
		await within(box).findByLabelText("Biển: 1 phiếu, 100%, bạn đã chọn", {}, LONG);
	});

	it("lists who chose each answer of a public poll", async () => {
		const { f, lan, minh, chat } = setup();
		const { seq } = f.server.sendMessage(lan, chat, "", 0, { poll: { question: "Ai đi?", options: ["Đi", "Không"], publicVoters: true } });
		f.server.votePoll(lan, chat, seq, [0]);
		f.server.votePoll(minh, chat, seq, [1]);
		const log = await open(f, chat);
		const box = (await within(log).findByText("Ai đi?", {}, LONG)).closest<HTMLElement>(".poll");
		if (box === null) throw new Error("no poll");
		expect(within(box).getByText("Bình chọn công khai")).toBeTruthy();
		// Before voting the list is not offered, as Telegram does.
		expect(within(box).queryByRole("button", { name: "Xem ai đã chọn" })).toBeNull();
		await userEvent.click(within(box).getByRole("button", { name: "Đi" }));
		await userEvent.click(await within(box).findByRole("button", { name: "Xem ai đã chọn" }, LONG));
		const dialog = await screen.findByRole("dialog", { name: "Ai đã chọn gì" }, LONG);
		const go = await within(dialog).findByRole("region", { name: "Đi" }, LONG);
		expect(within(go).getByText("Đi · 2")).toBeTruthy();
		expect(within(go).getByText("Bạn")).toBeTruthy();
		expect(within(go).getByText("Lan Anh")).toBeTruthy();
		const no = within(dialog).getByRole("region", { name: "Không" });
		expect(within(no).getByText("Minh")).toBeTruthy();
	});

	it("lets the sender stop their poll with a second click", async () => {
		const { f, chat } = setup();
		const { seq } = f.server.sendMessage(f.selfId, chat, "", 0, { poll: { question: "Họp lúc mấy giờ?", options: ["9h", "10h"] } });
		const log = await open(f, chat);
		const box = (await within(log).findByText("Họp lúc mấy giờ?", {}, LONG)).closest<HTMLElement>(".poll");
		if (box === null) throw new Error("no poll");
		await userEvent.click(within(box).getByRole("button", { name: "Kết thúc bình chọn" }));
		expect(f.pollsClosed).toEqual([]);
		await userEvent.click(within(box).getByRole("button", { name: "Bấm lần nữa để kết thúc" }));
		await within(box).findByText("Đã kết thúc", {}, LONG);
		expect(f.pollsClosed).toEqual([{ chatId: chat, seq }]);
		expect(within(box).queryByRole("button", { name: "9h" })).toBeNull();
	});

	it("posts a poll from the attach menu and shows it in the list preview", async () => {
		const { f, chat } = setup();
		const log = await open(f, chat);
		await userEvent.click(await screen.findByRole("button", { name: "Đính kèm" }, LONG));
		const menu = await screen.findByRole("menu", { name: "Đính kèm" }, LONG);
		await userEvent.click(within(menu).getByRole("menuitem", { name: "Bình chọn" }));
		const dialog = await screen.findByRole("dialog", { name: "Tạo bình chọn" }, LONG);
		await userEvent.click(within(dialog).getByRole("button", { name: "Gửi bình chọn" }));
		expect(within(dialog).getByRole("alert").textContent).toBe("Nhập câu hỏi");
		await userEvent.type(within(dialog).getByLabelText("Câu hỏi"), "Tối nay xem phim gì?");
		await userEvent.type(within(dialog).getByRole("textbox", { name: "Đáp án 1" }), "Phim A");
		await userEvent.type(within(dialog).getByRole("textbox", { name: "Đáp án 2" }), "Phim B");
		await userEvent.click(within(dialog).getByRole("button", { name: "Gửi bình chọn" }));
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Tạo bình chọn" })).toBeNull(), LONG);
		expect(f.pollsSent).toEqual([
			{ chatId: chat, topicId: 0, question: "Tối nay xem phim gì?", options: ["Phim A", "Phim B"], multiple: false, publicVoters: false, quiz: false, correct: 0 },
		]);
		await within(log).findByText("Tối nay xem phim gì?", {}, LONG);
		const list = await screen.findByRole("list", { name: "Danh sách chat" }, LONG);
		await within(list).findByText(/📊 Tối nay xem phim gì\?/, {}, LONG);
	});
});

describe("poll helpers", () => {
	it("counts percent of the voters, zero with nobody", () => {
		expect([pollPercent(1, 3), pollPercent(2, 3), pollPercent(0, 0)]).toEqual([33, 67, 0]);
	});

	it("builds the draft from the form: blank and repeated answers dropped, the quiz answer moved with them", () => {
		const flags = { anonymous: true, multiple: true, quiz: false, correct: 0, explanation: "x" };
		expect(pollDraft("  ", ["a", "b"], flags)).toBe("question");
		expect(pollDraft("q", ["a", " ", "a"], flags)).toBe("options");
		expect(pollDraft(" q ", ["a", "", "b"], flags)).toEqual({
			question: "q",
			options: ["a", "b"],
			multiple: true,
			publicVoters: false,
			quiz: false,
			correct: 0,
			explanation: "",
		});
		expect(pollDraft("q", ["", "a", "b"], { ...flags, quiz: true, correct: 2, explanation: " vì " })).toEqual({
			question: "q",
			options: ["a", "b"],
			multiple: false,
			publicVoters: false,
			quiz: true,
			correct: 1,
			explanation: "vì",
		});
	});
});
