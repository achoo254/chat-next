// "Cloud của tôi", the chat with yourself (mockups/chat.html#first-run,
// #info-panels, #delete-chat), and photo previews in the chat list
// (#list-states .pv-thumb): clearing the Cloud with its own wording, its
// note-taking placeholder, no mute action, reactions without your own face,
// and a small picture before photo and video previews.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ChatType } from "@app/proto-ts/chats";
import { pillContent } from "../src/messaging/ui/reaction-pill.ts";
import { seedDemo } from "./support/demo-data.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const LONG = { timeout: 8000 };
const THUMB = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

function seedCloud() {
	const demo = seedDemo();
	const f = demo.fixture;
	const cloud = f.createChat(ChatType.PRIVATE, "", [f.selfId]);
	const note = f.send(f.selfId, cloud, "Link tài liệu onboarding");
	return { demo, f, cloud, note };
}

describe("Cloud của tôi", () => {
	it("clears every message with its own dialog, from the info column", async () => {
		const { f, cloud } = seedCloud();
		renderMessaging(f, `/c/${cloud}`);
		const info = await screen.findByRole("complementary", { name: "Cloud của tôi" }, LONG);
		// Your own notes: pin only, nothing to mute.
		const quick = within(info).getByRole("group", { name: "Thao tác nhanh" });
		expect(within(quick).queryByRole("button", { name: /Tắt thông báo/ })).toBeNull();
		expect(within(quick).getAllByRole("button")).toHaveLength(1);
		expect(within(quick).getByRole("button", { name: /Ghim|Bỏ ghim/ })).toBeTruthy();

		await userEvent.click(within(info).getByRole("button", { name: "Xoá toàn bộ tin nhắn" }));
		const dialog = await screen.findByRole("dialog", { name: "Xoá toàn bộ tin trong Cloud của tôi?" }, LONG);
		expect(within(dialog).getByText("Xoá trên mọi thiết bị của bạn, không khôi phục được. Cloud của tôi vẫn ở đầu danh sách.")).toBeTruthy();
		expect(within(dialog).queryByText(/Thu hồi/)).toBeNull();
		await userEvent.click(within(dialog).getByRole("button", { name: "Xoá toàn bộ" }));
		await waitFor(() => expect(document.querySelector(".toast")?.textContent).toBe("Đã xoá toàn bộ tin trong Cloud của tôi"));
		expect(f.deletedChats).toEqual([cloud]);
		// The Cloud stays open and listed, now empty (it is cleared, not gone).
		expect(window.location.pathname).toBe(`/c/${cloud}`);
		const log = screen.getByRole("log", { name: "Tin nhắn" });
		await waitFor(() => expect(within(log).queryByText("Link tài liệu onboarding")).toBeNull(), LONG);
		const list = screen.getByRole("list", { name: "Danh sách chat" });
		expect(within(list).getByRole("link", { name: /Cloud của tôi/ })).toBeTruthy();
		expect(screen.getByPlaceholderText("Ghi chú vào Cloud của tôi")).toBeTruthy();
	});

	it("names the clear action the same way in the chat list menu", async () => {
		const { f } = seedCloud();
		renderMessaging(f, "/");
		const list = await screen.findByRole("list", { name: "Danh sách chat" }, LONG);
		await userEvent.click(await within(list).findByRole("button", { name: /Cloud của tôi/ }, LONG));
		const menu = await screen.findByRole("menu", {}, LONG);
		expect(within(menu).getByRole("menuitem", { name: "Xoá toàn bộ tin nhắn" })).toBeTruthy();
		expect(within(menu).queryByRole("menuitem", { name: "Xoá chat" })).toBeNull();
	});

	it("asks for a note in the composer", async () => {
		const { f, cloud } = seedCloud();
		renderMessaging(f, `/c/${cloud}`);
		expect(await screen.findByPlaceholderText("Ghi chú vào Cloud của tôi", {}, LONG)).toBeTruthy();
	});

	it("shows reactions as emoji and count, without your own face", async () => {
		expect(pillContent({ type: "private", memberCount: 1 }, { count: 1, recentUserIds: [7] }, true)).toEqual({ kind: "count", count: 1 });
		expect(pillContent({ type: "private", memberCount: 2 }, { count: 1, recentUserIds: [7] })).toEqual({ kind: "avatars", ids: [7], more: 0 });
		const { f, cloud, note } = seedCloud();
		f.server.react(f.selfId, cloud, note, "👍");
		renderMessaging(f, `/c/${cloud}`);
		const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
		const chip = await within(log).findByRole("button", { name: /👍/ }, LONG);
		expect(chip.querySelector(".avatar")).toBeNull();
		expect(chip.textContent).toContain("1");
	});
});

describe("chat list previews of photos and videos", () => {
	it("put a small thumbnail before the caption, or before Ảnh/Video without one; files stay text", async () => {
		const demo = seedDemo();
		const f = demo.fixture;
		f.enableMedia();
		const { huy, minh, lan } = demo.ids.users;
		f.sendFile(huy, demo.ids.huy, { kind: "photo", mimeType: "image/jpeg", bytes: new Uint8Array(8), width: 40, height: 30, inlineThumb: THUMB }, "Ảnh chụp lỗi trên staging");
		f.sendFile(minh, demo.ids.mobile, { kind: "video", mimeType: "video/mp4", bytes: new Uint8Array(8), width: 40, height: 30, inlineThumb: THUMB });
		f.sendFile(lan, demo.ids.lanAnh, { kind: "document", name: "bao-cao.pdf", mimeType: "application/pdf", bytes: new Uint8Array(8) });
		renderMessaging(f, "/");
		const list = await screen.findByRole("list", { name: "Danh sách chat" }, LONG);

		const photoRow = (await within(list).findByText("Ảnh chụp lỗi trên staging", { exact: false }, LONG)).closest(".preview") as HTMLElement;
		const photo = photoRow.querySelector("img.pv-thumb");
		expect(photo?.getAttribute("src")).toMatch(/^data:image\/jpeg;base64,/);
		expect(photo?.getAttribute("alt")).toBe("Ảnh");

		const videoRow = within(list).getByRole("link", { name: /Team Mobile/ }).querySelector(".preview") as HTMLElement;
		await waitFor(() => expect(videoRow.textContent).toContain("Video"));
		expect(videoRow.querySelector("img.pv-thumb")?.getAttribute("alt")).toBe("");

		const fileRow = (await within(list).findByText("File: bao-cao.pdf", { exact: false }, LONG)).closest(".preview") as HTMLElement;
		expect(fileRow.querySelector(".pv-thumb")).toBeNull();
	});
});
