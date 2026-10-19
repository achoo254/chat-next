// Media (R3, mockups/media.html) through the real client core and the
// in-memory server with its MediaService: attaching (menu, picker, drop,
// paste), uploads with progress, cancel and retry, refused files, albums,
// the viewer (keys, swipe, zoom, a message deleted while open), voice
// messages, file cards, link preview photos, shared media in the info
// column and forwarding without uploading again.
import { ChatType } from "@app/proto-ts/chats";
import { EntityType } from "@app/proto-ts/messages";
import { MediaKind } from "@app/proto-ts/media";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { entity } from "./support/demo-data.ts";
import { ChatFixture, type FixtureFile } from "./support/fake-chat.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const LONG = { timeout: 8000 };

afterEach(() => {
	vi.restoreAllMocks();
});

function bytes(size: number, seed = 1): Uint8Array {
	return Uint8Array.from({ length: size }, (_, index) => (index * 31 + seed) % 251);
}

function photo(seed = 1): FixtureFile {
	return { kind: "photo", mimeType: "image/jpeg", bytes: bytes(2048, seed), width: 1200, height: 900, inlineThumb: bytes(40, seed), sizes: ["s", "m"] };
}

/** A private chat with Lan Anh, media on unless `media` is false. */
function setup(media = true, uploadSizeMax?: number) {
	const f = new ChatFixture();
	const lan = f.addUser("Lan Anh", { username: "lananh" });
	const chat = f.createChat(ChatType.PRIVATE, "", [f.selfId, lan]);
	const server = media ? f.enableMedia(uploadSizeMax) : null;
	f.send(lan, chat, "Gửi mình ảnh nhé");
	return { f, lan, chat, server };
}

async function open(f: ChatFixture, chat: number) {
	renderMessaging(f, `/c/${chat}`);
	const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
	await within(log).findByText("Gửi mình ảnh nhé", {}, LONG);
	return log;
}

function file(name: string, size: number, type: string): File {
	return new File([bytes(size).slice()], name, { type });
}

/** Picks files with the composer's file input (the OS picker opens on the menu item). */
function pick(files: File[], which: "pick-files" | "pick-media" = "pick-files"): void {
	const input = screen.getByTestId(which);
	fireEvent.change(input, { target: { files } });
}

describe("attaching", () => {
	it("hides the paper clip when the server has media off", async () => {
		const { f, chat } = setup(false);
		await open(f, chat);
		expect(screen.queryByRole("button", { name: "Đính kèm" })).toBeNull();
	});

	it("opens the attach menu with the per-file limit", async () => {
		const { f, chat } = setup(true);
		await open(f, chat);
		await userEvent.click(await screen.findByRole("button", { name: "Đính kèm" }, LONG));
		// The menu loads on first use.
		const menu = await screen.findByRole("menu", { name: "Đính kèm" }, LONG);
		expect(within(menu).getByRole("menuitem", { name: "Ảnh hoặc video" })).toBeTruthy();
		expect(within(menu).getByRole("menuitem", { name: /File.*tối đa 2 GB/ })).toBeTruthy();
		await userEvent.keyboard("{Escape}");
		expect(screen.queryByRole("menu", { name: "Đính kèm" })).toBeNull();
	});

	it("uploads a picked file with a caption, showing it at once, then as a file card", async () => {
		const { f, chat, server } = setup(true);
		const log = await open(f, chat);
		await screen.findByRole("button", { name: "Đính kèm" }, LONG);
		pick([file("bao-cao-q3.pdf", 300_000, "application/pdf")]);
		const tray = await screen.findByRole("group", { name: "File sắp gửi" }, LONG);
		expect(within(tray).getByText("bao-cao-q3.pdf")).toBeTruthy();
		expect(within(tray).getByText("1 file")).toBeTruthy();
		const box = screen.getByRole("textbox", { name: /Tin nhắn tới/ });
		expect(box.getAttribute("placeholder")).toBe("Thêm chú thích…");
		await userEvent.type(box, "Báo cáo quý 3{Enter}");
		expect(screen.queryByRole("group", { name: "File sắp gửi" })).toBeNull();
		// Confirmed: a file card with the size and type, and the caption.
		const card = await within(log).findByRole("button", { name: "Tải xuống bao-cao-q3.pdf" }, LONG);
		const bubble = card.closest(".bubble");
		expect(bubble?.textContent).toContain("Báo cáo quý 3");
		expect(bubble?.textContent).toContain("293 KB · PDF");
		expect([...(server?.files.values() ?? [])].some((stored) => stored.ref.fileName === "bao-cao-q3.pdf")).toBe(true);
	});

	it("shows progress while uploading, pauses and resumes", async () => {
		const { f, chat, server } = setup(true);
		if (server === null) throw new Error("media");
		// The storage keeps failing: the upload backs off and stays pending.
		server.putFault = () => 503;
		const log = await open(f, chat);
		await screen.findByRole("button", { name: "Đính kèm" }, LONG);
		pick([file("ban-thiet-ke.zip", 200_000, "application/zip")]);
		await screen.findByRole("group", { name: "File sắp gửi" }, LONG);
		await userEvent.click(screen.getByRole("button", { name: "Gửi" }));
		const bar = await within(log).findByRole("progressbar", { name: "Tiến độ tải lên" }, LONG);
		expect(bar.getAttribute("aria-valuemax")).toBe("100");
		expect(within(log).getByText("ban-thiet-ke.zip")).toBeTruthy();
		// Paused, it says so and offers to resume; resumed, it finishes once storage works.
		await userEvent.click(within(log).getByRole("button", { name: "Tạm dừng tải lên" }));
		expect(await within(log).findByText(/^Đã tạm dừng · /, {}, LONG)).toBeTruthy();
		expect(await screen.findByText("Đã tạm dừng, phần đã tải được giữ lại")).toBeTruthy();
		server.putFault = null;
		await userEvent.click(within(log).getByRole("button", { name: "Tiếp tục tải lên" }));
		expect(await screen.findByText("Tiếp tục từ phần đã tải")).toBeTruthy();
		expect(await within(log).findByRole("button", { name: "Tải xuống ban-thiet-ke.zip" }, LONG)).toBeTruthy();
	});

	it("cancels an upload from the message menu", async () => {
		const { f, chat, server } = setup(true);
		if (server === null) throw new Error("media");
		server.putFault = () => 503;
		const log = await open(f, chat);
		await screen.findByRole("button", { name: "Đính kèm" }, LONG);
		pick([file("ban-nhap.zip", 200_000, "application/zip")]);
		await screen.findByRole("group", { name: "File sắp gửi" }, LONG);
		await userEvent.click(screen.getByRole("button", { name: "Gửi" }));
		const name = await within(log).findByText("ban-nhap.zip", {}, LONG);
		fireEvent.contextMenu(name);
		await userEvent.click(await screen.findByRole("menuitem", { name: "Xoá" }));
		await waitFor(() => expect(within(log).queryByText("ban-nhap.zip")).toBeNull(), LONG);
	});

	it("marks a refused upload failed and sends it on retry", async () => {
		const { f, chat, server } = setup(true);
		if (server === null) throw new Error("media");
		server.refuse.add(MediaKind.DOCUMENT);
		const log = await open(f, chat);
		await screen.findByRole("button", { name: "Đính kèm" }, LONG);
		pick([file("lich-truc.xlsx", 5000, "application/vnd.ms-excel")]);
		await screen.findByRole("group", { name: "File sắp gửi" }, LONG);
		await userEvent.click(screen.getByRole("button", { name: "Gửi" }));
		const retry = await within(log).findByRole("button", { name: "Thử lại" }, LONG);
		expect(within(log).getByText(/Tải lên lỗi/)).toBeTruthy();
		server.refuse.clear();
		await userEvent.click(retry);
		expect(await within(log).findByRole("button", { name: "Tải xuống lich-truc.xlsx" }, LONG)).toBeTruthy();
	});

	it("refuses a file over the server's limit before uploading, in Vietnamese", async () => {
		const { f, chat, server } = setup(true, 2 ** 20);
		await open(f, chat);
		await screen.findByRole("button", { name: "Đính kèm" }, LONG);
		pick([file("quay-man-hinh.mov", 2 ** 20 + 10, "video/quicktime")], "pick-media");
		const alert = await screen.findByRole("alert", {}, LONG);
		expect(alert.textContent).toBe("Không gửi được quay-man-hinh.mov (1 MB): mỗi file tối đa 1 MB.");
		await userEvent.click(within(alert).getByRole("button", { name: "Đóng thông báo" }));
		expect(screen.queryByRole("group", { name: "File sắp gửi" })).toBeNull();
		expect(server?.calls.get("createUpload") ?? 0).toBe(0);
	});

	it("takes files dropped on the chat and images pasted into the composer", async () => {
		const { f, chat } = setup(true);
		await open(f, chat);
		await screen.findByRole("button", { name: "Đính kèm" }, LONG);
		const convo = document.querySelector(".convo");
		if (convo === null) throw new Error("no conversation");
		const dropped = file("so-do.pdf", 1000, "application/pdf");
		const dataTransfer = { types: ["Files"], items: [{ kind: "file" }], files: [dropped], dropEffect: "none" };
		fireEvent.dragEnter(convo, { dataTransfer });
		expect(screen.getByText("Thả file để gửi")).toBeTruthy();
		fireEvent.drop(convo, { dataTransfer });
		expect(screen.queryByText("Thả file để gửi")).toBeNull();
		const tray = await screen.findByRole("group", { name: "File sắp gửi" }, LONG);
		expect(within(tray).getByText("so-do.pdf")).toBeTruthy();

		const box = screen.getByRole("textbox", { name: /Tin nhắn tới/ });
		const shot = file("anh-chup.png", 1200, "image/png");
		fireEvent.paste(box, { clipboardData: { files: [shot], getData: () => "" } });
		await within(tray).findByText("anh-chup.png");
		expect(within(tray).getByText("2 file")).toBeTruthy();
	});
});

describe("albums", () => {
	it("groups messages sent together into one album with one caption", async () => {
		const { f, lan, chat } = setup(true);
		for (const [index, seed] of [1, 2, 3].entries()) f.sendFile(lan, chat, photo(seed), index === 0 ? "Ba màn trước khi nâng cấp" : "", 77);
		const log = await open(f, chat);
		const album = await within(log).findByRole("group", { name: "Album 3 ảnh và video" }, LONG);
		expect(within(album).getAllByRole("button", { name: /^Ảnh \d$/ })).toHaveLength(3);
		expect(within(log).getAllByText("Ba màn trước khi nâng cấp")).toHaveLength(1);
		// One row in the list for the whole album.
		expect(log.querySelectorAll(".msg .album")).toHaveLength(1);
	});

	it("sends picked photos as an album", async () => {
		const { f, chat, server } = setup(true);
		const log = await open(f, chat);
		await screen.findByRole("button", { name: "Đính kèm" }, LONG);
		pick([file("a.png", 3000, "image/png"), file("b.png", 4000, "image/png")], "pick-media");
		const tray = await screen.findByRole("group", { name: "File sắp gửi" }, LONG);
		expect(within(tray).getByText("2 file · gửi thành album")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Gửi" }));
		const album = await within(log).findByRole("group", { name: "Album 2 ảnh và video" }, LONG);
		await waitFor(() => expect(within(album).getAllByRole("button", { name: /^Ảnh \d$/ })).toHaveLength(2), LONG);
		expect(server?.calls.get("completeUpload")).toBe(2);
	});
});

describe("viewer", () => {
	it("moves with ← →, swipes, zooms and closes with Esc", async () => {
		const { f, lan, chat } = setup(true);
		for (const seed of [1, 2, 3]) f.sendFile(lan, chat, photo(seed), "", 9);
		const log = await open(f, chat);
		const album = await within(log).findByRole("group", { name: "Album 3 ảnh và video" }, LONG);
		await userEvent.click(within(album).getByRole("button", { name: "Ảnh 1" }));
		const viewer = await screen.findByRole("dialog", { name: "Lan Anh" }, LONG);
		expect(within(viewer).getByText("1 / 3")).toBeTruthy();
		expect(within(viewer).getByRole("button", { name: "Ảnh 1" }).getAttribute("aria-current")).toBe("true");
		fireEvent.keyDown(within(viewer).getByRole("button", { name: "Đóng" }), { key: "ArrowRight" });
		expect(within(viewer).getByText("2 / 3")).toBeTruthy();
		const stage = viewer.querySelector(".v-stage");
		if (stage === null) throw new Error("no stage");
		fireEvent.touchStart(stage, { changedTouches: [{ clientX: 300 }] });
		fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 120 }] });
		expect(within(viewer).getByText("3 / 3")).toBeTruthy();
		fireEvent.touchStart(stage, { changedTouches: [{ clientX: 100 }] });
		fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 260 }] });
		expect(within(viewer).getByText("2 / 3")).toBeTruthy();
		await userEvent.click(within(viewer).getByRole("button", { name: "Phóng to" }));
		expect(within(viewer).getByText("150%")).toBeTruthy();
		fireEvent(viewer, new Event("cancel", { cancelable: true }));
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Lan Anh" })).toBeNull());
	});

	it("says the media is gone when the sender deletes it while it is open", async () => {
		const { f, lan, chat, server } = setup(true);
		const seq = f.sendFile(lan, chat, photo(4), "Dashboard sau nâng cấp");
		const log = await open(f, chat);
		await userEvent.click(await within(log).findByRole("button", { name: "Xem ảnh" }, LONG));
		const viewer = await screen.findByRole("dialog", { name: "Lan Anh" }, LONG);
		server?.revoked.add(`${chat}:${seq}`);
		f.server.deleteMessages(lan, chat, [seq]);
		expect(await within(viewer).findByText("Media này không còn", {}, LONG)).toBeTruthy();
		expect(within(viewer).getByText("Không còn trong album")).toBeTruthy();
		// The message keeps its place as a tombstone.
		expect(await within(log).findByText("Tin nhắn đã thu hồi", {}, LONG)).toBeTruthy();
	});
});

describe("voice, files and link previews", () => {
	it("plays a voice message with its waveform and length", async () => {
		const { f, lan, chat } = setup(true);
		f.sendFile(lan, chat, { kind: "voice", mimeType: "audio/ogg", bytes: bytes(900), duration: 27_000, waveform: bytes(100, 7) });
		vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
			this.dispatchEvent(new Event("play"));
			return Promise.resolve();
		});
		const log = await open(f, chat);
		const play = await within(log).findByRole("button", { name: "Phát tin thoại 27 giây" }, LONG);
		await waitFor(() => expect((play as HTMLButtonElement).disabled).toBe(false), LONG);
		const voice = play.closest(".voice");
		expect(voice?.querySelectorAll(".wave i")).toHaveLength(40);
		expect(voice?.textContent).toContain("0:27");
		await userEvent.click(play);
		expect(play.getAttribute("aria-pressed")).toBe("true");
		expect(play.getAttribute("aria-label")).toBe("Tạm dừng tin thoại");
		expect(voice?.textContent).toContain("Đang phát");
		expect(within(log).getByRole("slider", { name: "Tua tin thoại" }).getAttribute("aria-valuemax")).toBe("27");
	});

	it("shows a file card and says when the file is gone", async () => {
		const { f, lan, chat, server } = setup(true);
		const seq = f.sendFile(lan, chat, { kind: "document", name: "bao-cao-van-hanh-q3.pdf", mimeType: "application/pdf", bytes: bytes(2_500_000) });
		const log = await open(f, chat);
		const download = await within(log).findByRole("button", { name: "Tải xuống bao-cao-van-hanh-q3.pdf" }, LONG);
		const card = download.closest(".file-card");
		expect(card?.textContent).toContain("2,4 MB · PDF");
		expect(card?.querySelector(".file-ext")?.textContent).toBe("PDF");
		server?.revoked.add(`${chat}:${seq}`);
		await userEvent.click(download);
		expect(await within(log).findByText("File này không còn", {}, LONG)).toBeTruthy();
		expect(within(log).getByRole("button", { name: "Tải xuống không khả dụng" })).toHaveProperty("disabled", true);
	});

	it("shows the photo of a link preview", async () => {
		const { f, lan, chat, server } = setup(true);
		const ref = f.addFile(0, photo(9));
		const url = "https://status.example.com";
		f.send(lan, chat, url, {
			entities: [entity(EntityType.URL, url, url)],
			linkPreview: { url, siteName: "status.example.com", title: "Trạng thái dịch vụ", description: "Mọi hệ thống hoạt động bình thường.", photo: ref },
		});
		const log = await open(f, chat);
		const card = (await within(log).findByText("Trạng thái dịch vụ", {}, LONG)).closest("a.lp");
		expect(card?.classList.contains("has-thumb")).toBe(true);
		const thumb = await within(card as HTMLElement).findByRole("img", { name: "Ảnh xem trước của trang" }, LONG);
		await waitFor(() => expect(thumb.querySelector("img.pic-full")).not.toBeNull(), LONG);
		expect(server?.gets.some((get) => get.includes(`/f/${ref.fileId}/`))).toBe(true);
	});
});

describe("shared media and forwarding", () => {
	it("lists only the kinds the chat has, each in its own tab", async () => {
		const { f, lan, chat } = setup(true);
		f.sendFile(lan, chat, photo(2));
		f.sendFile(lan, chat, { kind: "video", mimeType: "video/mp4", bytes: bytes(5000), width: 1280, height: 720, duration: 134_000 });
		f.sendFile(lan, chat, { kind: "document", name: "alertmanager.yml", mimeType: "text/yaml", bytes: bytes(4000) });
		await open(f, chat);
		// A 1-1 chat opens with the info column beside it on a wide screen.
		const info = await screen.findByRole("complementary", { name: "Thông tin" }, LONG);
		const photos = await within(info).findByRole("button", { name: /Ảnh và video\s*2/ }, LONG);
		expect(within(info).getByRole("button", { name: /^File\s*1$/ })).toBeTruthy();
		expect(within(info).queryByRole("button", { name: /^Link/ })).toBeNull();
		await userEvent.click(photos);
		const tabs = await screen.findByRole("tablist", { name: "Loại media" }, LONG);
		expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Ảnh/Video", "File"]);
		const panel = screen.getByRole("tabpanel");
		expect(within(panel).getByRole("button", { name: "Phát video, 2 phút 14 giây" })).toBeTruthy();
		await userEvent.click(within(tabs).getByRole("tab", { name: "File" }));
		expect(within(screen.getByRole("tabpanel")).getByText("alertmanager.yml")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Quay lại thông tin chat" }));
		expect(await screen.findByRole("button", { name: /Ảnh và video\s*2/ }, LONG)).toBeTruthy();
	});

	it("forwards an album as its messages, without uploading again", async () => {
		const { f, lan, chat, server } = setup(true);
		const group = f.createChat(ChatType.GROUP, "Nhóm thiết kế", [f.selfId, lan]);
		f.send(lan, group, "Chào nhóm");
		const seqs = [1, 2].map((seed) => f.sendFile(lan, chat, photo(seed), "", 31));
		const log = await open(f, chat);
		const album = await within(log).findByRole("group", { name: "Album 2 ảnh và video" }, LONG);
		const message = album.closest(".msg");
		if (message === null) throw new Error("no message");
		await userEvent.click(within(message as HTMLElement).getByRole("button", { name: "Chuyển tiếp", hidden: true }));
		const dialog = await screen.findByRole("dialog", { name: "Chuyển tiếp tới" }, LONG);
		await userEvent.click(await within(dialog).findByRole("checkbox", { name: /Nhóm thiết kế/ }, LONG));
		await userEvent.click(within(dialog).getByRole("button", { name: "Gửi tới 1 chat" }));
		await waitFor(() => expect(f.forwards).toEqual([{ from: chat, seqs, to: group }]), LONG);
		expect(server?.calls.get("createUpload") ?? 0).toBe(0);
	});
});

describe("voice recording", () => {
	/** MediaRecorder and a microphone stream, enough for the recorder to run in jsdom. */
	function stubRecording(getUserMedia: () => Promise<MediaStream>) {
		class FakeRecorder extends EventTarget {
			state: "inactive" | "recording" = "inactive";
			mimeType = "audio/webm;codecs=opus";
			start() {
				this.state = "recording";
			}
			stop() {
				this.state = "inactive";
				const data = Object.assign(new Event("dataavailable"), { data: new Blob([bytes(3000).slice()], { type: "audio/webm" }) });
				this.dispatchEvent(data);
				this.dispatchEvent(new Event("stop"));
			}
		}
		vi.stubGlobal("MediaRecorder", FakeRecorder);
		Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
	}

	afterEach(() => {
		vi.unstubAllGlobals();
		Reflect.deleteProperty(navigator, "mediaDevices");
	});

	it("records and sends a voice message from the microphone button", async () => {
		const stream = { getTracks: () => [{ stop: () => undefined }] } as unknown as MediaStream;
		stubRecording(() => Promise.resolve(stream));
		let now = 1_760_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const { f, chat, server } = setup(true);
		const log = await open(f, chat);
		await userEvent.click(await screen.findByRole("button", { name: "Ghi âm tin thoại" }, LONG));
		const recorder = await screen.findByRole("group", { name: "Ghi âm tin thoại" }, LONG);
		const send = await within(recorder).findByRole("button", { name: "Gửi tin thoại" }, LONG);
		await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false), LONG);
		now += 4200;
		await userEvent.click(send);
		expect(await within(log).findByRole("button", { name: /^Phát tin thoại/ }, LONG)).toBeTruthy();
		await waitFor(() => expect(f.uploadRequests).toHaveLength(1), LONG);
		expect(f.uploadRequests[0]).toMatchObject({ kind: MediaKind.VOICE, fileName: "voice.webm", mimeType: "audio/webm", duration: 4200 });
		await waitFor(() => expect([...(server?.files.values() ?? [])].some((entry) => entry.ref.kind === MediaKind.VOICE)).toBe(true), LONG);
	});

	it("says when the microphone is not allowed and keeps the composer", async () => {
		stubRecording(() => Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" })));
		const { f, chat } = setup(true);
		await open(f, chat);
		await userEvent.click(await screen.findByRole("button", { name: "Ghi âm tin thoại" }, LONG));
		expect((await screen.findByRole("alert", {}, LONG)).textContent).toBe(
			"Chưa có quyền dùng micro. Cho phép micro trong cài đặt trình duyệt rồi thử lại.",
		);
		await userEvent.click(screen.getByRole("button", { name: "Huỷ ghi âm" }));
		expect(await screen.findByRole("textbox", { name: /Tin nhắn tới/ }, LONG)).toBeTruthy();
	});
});
