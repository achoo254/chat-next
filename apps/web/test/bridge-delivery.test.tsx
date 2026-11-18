// A chat that sends on to another app (Chat Bridge): the messages that are not
// finished say where they are, a failed one can be tried again or given up, and
// a chat that is not connected costs nothing. The server is a fake BridgeService.
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BridgeOutboxStatus, type BridgeOutboxItem } from "@achoo254/chat-proto/bridge";
import { ChatType } from "@achoo254/chat-proto/chats";
import { afterEach, describe, expect, it } from "vitest";
import { ChatFixture } from "./support/fake-chat.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const LONG = { timeout: 8000 };

afterEach(cleanup);

function item(seq: number, op: string, status: BridgeOutboxStatus, lastError = ""): BridgeOutboxItem {
	return { $typeName: "app.v1.BridgeOutboxItem", seq: BigInt(seq), op, status, lastError, attempts: 1 };
}

/** A two-way chat with one message of mine, and what its outbox holds. */
function twoWay(items: (seq: number) => BridgeOutboxItem[]): { fixture: ChatFixture; chatId: number; seq: number } {
	const fixture = new ChatFixture();
	const partner = fixture.addUser("Anh Đô");
	const chatId = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, partner]);
	fixture.send(partner, chatId, "chào bạn");
	const seq = fixture.send(fixture.selfId, chatId, "tin của tôi");
	fixture.bridge.seedTwoWay(chatId);
	fixture.bridge.outbox.set(chatId, items(seq));
	return { fixture, chatId, seq };
}

/** The bubble of my message in the open conversation (the same text also shows in the chat list). */
async function myBubble(): Promise<HTMLElement> {
	const found = await waitFor(() => {
		const el = screen.getAllByText("tin của tôi").map((node) => node.closest<HTMLElement>(".bubble")).find((node) => node !== null);
		if (el === undefined || el === null) throw new Error("the message is not shown yet");
		return el;
	}, LONG);
	return found;
}

describe("a chat that sends on to another app", () => {
	it("says what you type is also sent, and where a message waiting to go is", async () => {
		const { fixture, chatId } = twoWay((seq) => [item(seq, "send", BridgeOutboxStatus.PENDING)]);
		renderMessaging(fixture, `/c/${chatId}`);
		expect(await screen.findByText("Tin bạn gõ ở đây cũng được gửi sang Telegram.", {}, LONG)).toBeTruthy();
		const bubble = await myBubble();
		expect(await within(bubble).findByLabelText("Đang gửi sang Telegram", {}, LONG)).toBeTruthy();
		expect(within(bubble).queryByRole("button", { name: "Gửi lại" })).toBeNull();
	});

	it("tells that the app refused a pin, once, without calling the message failed", async () => {
		const { fixture, chatId } = twoWay((seq) => [item(seq, "pin_message", BridgeOutboxStatus.FAILED, "not allowed: CHAT_ADMIN_REQUIRED")]);
		renderMessaging(fixture, `/c/${chatId}`);
		await waitFor(() => expect(document.querySelector(".toast")?.textContent ?? "").toContain("Telegram không cho ghim tin nhắn này; đã trả về như cũ."), LONG);
		const bubble = await myBubble();
		expect(within(bubble).queryByText("Chưa gửi sang Telegram")).toBeNull();
		expect(within(bubble).queryByRole("button", { name: "Gửi lại" })).toBeNull();
	});

	it("offers to resend a message the app refused, and goes back to sending when asked", async () => {
		const { fixture, chatId, seq } = twoWay((s) => [item(s, "send", BridgeOutboxStatus.FAILED, "not allowed: CHAT_WRITE_FORBIDDEN")]);
		renderMessaging(fixture, `/c/${chatId}`);
		const bubble = await myBubble();
		expect((await within(bubble).findAllByText("Chưa gửi sang Telegram", {}, LONG)).length).toBeGreaterThan(0);
		await userEvent.click(within(bubble).getByRole("button", { name: "Gửi lại" }));
		await waitFor(() => expect(fixture.bridge.calls).toContain(`retry:${chatId}:${seq}`));
		expect(await within(bubble).findByLabelText("Đang gửi sang Telegram", {}, LONG)).toBeTruthy();
		expect(within(bubble).queryByRole("button", { name: "Gửi lại" })).toBeNull();
	});

	it("says a message may or may not have arrived when the server stopped in the middle", async () => {
		const { fixture, chatId } = twoWay((s) => [item(s, "send", BridgeOutboxStatus.UNKNOWN)]);
		renderMessaging(fixture, `/c/${chatId}`);
		const bubble = await myBubble();
		expect((await within(bubble).findAllByText("Chưa rõ đã gửi sang Telegram chưa", {}, LONG)).length).toBeGreaterThan(0);
		expect(within(bubble).getByRole("button", { name: "Gửi lại" })).toBeTruthy();
	});

	it("gives up a failed message by deleting it", async () => {
		const { fixture, chatId } = twoWay((s) => [item(s, "send", BridgeOutboxStatus.FAILED, "not allowed")]);
		renderMessaging(fixture, `/c/${chatId}`);
		const bubble = await myBubble();
		await userEvent.click(await within(bubble).findByRole("button", { name: "Xoá tin" }, LONG));
		expect(await screen.findByText("Tin nhắn đã thu hồi", {}, LONG)).toBeTruthy();
	});

	it("lets a failed edit be dismissed, never deleted", async () => {
		const { fixture, chatId, seq } = twoWay((s) => [item(s, "edit", BridgeOutboxStatus.FAILED, "edit expired")]);
		renderMessaging(fixture, `/c/${chatId}`);
		const bubble = await myBubble();
		expect((await within(bubble).findAllByText("Bản sửa chưa sang Telegram", {}, LONG)).length).toBeGreaterThan(0);
		expect(within(bubble).queryByRole("button", { name: "Xoá tin" })).toBeNull();
		await userEvent.click(within(bubble).getByRole("button", { name: "Bỏ qua" }));
		await waitFor(() => expect(fixture.bridge.calls).toContain(`dismiss:${chatId}:${seq}`));
		await waitFor(() => expect(within(bubble).queryByRole("button", { name: "Bỏ qua" })).toBeNull());
	});

	it("shows nothing and does not ask for an outbox when the chat is not connected", async () => {
		const fixture = new ChatFixture();
		const partner = fixture.addUser("Lan");
		const chatId = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, partner]);
		fixture.send(fixture.selfId, chatId, "tin thường");
		renderMessaging(fixture, `/c/${chatId}`);
		expect((await screen.findAllByText("tin thường", {}, LONG)).length).toBeGreaterThan(0);
		expect(screen.queryByText(/cũng được gửi sang/)).toBeNull();
		expect(fixture.bridge.outboxLooks).toBe(0);
	});

	it("shows nothing when the server has the bridge off", async () => {
		const { fixture, chatId } = twoWay((s) => [item(s, "send", BridgeOutboxStatus.FAILED)]);
		fixture.bridge.disabled = true;
		renderMessaging(fixture, `/c/${chatId}`);
		expect((await screen.findAllByText("tin của tôi", {}, LONG)).length).toBeGreaterThan(0);
		expect(screen.queryByText(/cũng được gửi sang/)).toBeNull();
		expect(screen.queryByRole("button", { name: "Gửi lại" })).toBeNull();
	});
});
