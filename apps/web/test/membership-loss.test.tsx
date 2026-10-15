// Losing membership of a group while using it, and the member dialogs'
// keyboard behaviour: the conversation says why instead of a network error,
// nothing of the group is asked from the server any more, other members'
// lists follow removals made elsewhere, and Esc always closes the topmost
// dialog with focus returned to where it came from.
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { navigate, paths } from "../src/router.tsx";
import { seedDemo } from "./support/demo-data.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const LONG = { timeout: 8000 };
const NETWORK_ERROR = "Không tải được tin nhắn. Kiểm tra kết nối mạng rồi thử lại.";

async function openOps(demo = seedDemo()) {
	renderMessaging(demo.fixture, `/c/${demo.ids.ops}`);
	const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
	await within(log).findByText("Dashboard ổn định.", {}, LONG);
	return { demo, log };
}

/** Ends the user's membership on the server; `silently` writes no member_removed (a missed update). */
function dropSelf(demo: ReturnType<typeof seedDemo>, by: number, silently = false): void {
	const { fixture, ids } = demo;
	if (silently) fixture.server.dropMemberSilently(ids.ops, fixture.selfId);
	else fixture.server.removeMember(ids.ops, fixture.selfId, by);
	fixture.members.set(ids.ops, (fixture.members.get(ids.ops) ?? []).filter((id) => id !== fixture.selfId));
}

describe("removed from a group", () => {
	it("says so in place of the composer, purges the chat and offers to close it", async () => {
		const { demo } = await openOps();
		expect(await screen.findByRole("textbox", { name: "Tin nhắn tới Vận hành hệ thống" }, LONG)).toBeTruthy();

		dropSelf(demo, demo.ids.users.huy);

		expect(await screen.findByText("Bạn đã bị xoá khỏi nhóm này.", {}, LONG)).toBeTruthy();
		expect(screen.queryByRole("textbox", { name: "Tin nhắn tới Vận hành hệ thống" })).toBeNull();
		expect(screen.queryByText(NETWORK_ERROR)).toBeNull();
		// The messages went from this device, and the chat from the list.
		await waitFor(() => expect(screen.queryByText("Dashboard ổn định.")).toBeNull(), LONG);
		const list = screen.getByRole("region", { name: "Danh sách chat" });
		await waitFor(() => expect(within(list).queryByText("Vận hành hệ thống")).toBeNull(), LONG);
		// The info column no longer lists the members (the server refuses them now).
		const info = await screen.findByRole("complementary", { name: "Thông tin nhóm" }, LONG);
		expect(within(info).queryByRole("button", { name: /^Xem tất cả \d+ thành viên$/ })).toBeNull();
		expect(within(info).queryByRole("button", { name: "Rời nhóm" })).toBeNull();

		await userEvent.click(screen.getByRole("button", { name: "Đóng chat" }));
		await waitFor(() => expect(window.location.pathname).toBe(paths.home), LONG);
	});

	it("shows the same state, not a network error, when the removal update was missed", async () => {
		const demo = seedDemo();
		renderMessaging(demo.fixture, "/");
		const list = await screen.findByRole("region", { name: "Danh sách chat" }, LONG);
		await within(list).findByText("Vận hành hệ thống", {}, LONG);

		dropSelf(demo, 0, true);
		act(() => navigate(paths.chat(demo.ids.ops)));

		expect(await screen.findByText("Bạn không còn là thành viên của nhóm này.", {}, LONG)).toBeTruthy();
		expect(screen.queryByText(NETWORK_ERROR)).toBeNull();
		expect(screen.queryByRole("textbox", { name: "Tin nhắn tới Vận hành hệ thống" })).toBeNull();
		await waitFor(() => expect(within(list).queryByText("Vận hành hệ thống")).toBeNull(), LONG);
	});

	it("updates another member's list when someone is removed elsewhere", async () => {
		const { demo } = await openOps();
		const { minh, huy } = demo.ids.users;
		const info = await screen.findByRole("complementary", { name: "Thông tin nhóm" }, LONG);
		await within(info).findByText("Minh", {}, LONG);

		demo.fixture.server.removeMember(demo.ids.ops, minh, huy);
		demo.fixture.members.set(demo.ids.ops, (demo.fixture.members.get(demo.ids.ops) ?? []).filter((id) => id !== minh));

		await waitFor(() => expect(within(info).queryByText("Minh")).toBeNull(), LONG);
	});
});

describe("member dialogs and Esc", () => {
	it("closes the member list with Esc after a removal and returns focus to its opener", async () => {
		const { demo } = await openOps();
		const info = await screen.findByRole("complementary", { name: "Thông tin nhóm" }, LONG);
		const opener = await within(info).findByRole("button", { name: /^Xem tất cả \d+ thành viên$/ }, LONG);
		await userEvent.click(opener);

		let members = await screen.findByRole("dialog", { name: /^Thành viên · \d+$/ }, LONG);
		await waitFor(() => expect(members.contains(document.activeElement)).toBe(true));
		await userEvent.click(await within(members).findByRole("button", { name: "Thao tác với Minh" }, LONG));
		await userEvent.click(within(screen.getByRole("menu", { name: "Thao tác với Minh" })).getByRole("menuitem", { name: "Xoá khỏi nhóm" }));
		const confirm = await screen.findByRole("dialog", { name: "Xoá Minh khỏi nhóm?" }, LONG);
		await waitFor(() => expect(confirm.contains(document.activeElement)).toBe(true));
		await userEvent.click(within(confirm).getByRole("button", { name: "Xoá và cấm vào lại" }));
		await waitFor(() => expect(demo.fixture.removals).toHaveLength(1), LONG);

		// Back on the list: focus is inside it again, so Esc reaches it.
		members = await screen.findByRole("dialog", { name: /^Thành viên · \d+$/ }, LONG);
		await waitFor(() => expect(within(members).queryByText("Minh")).toBeNull(), LONG);
		await waitFor(() => expect(members.contains(document.activeElement)).toBe(true));
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog", { name: /^Thành viên · \d+$/ })).toBeNull(), LONG);
		await waitFor(() => expect(document.activeElement).toBe(within(info).getByRole("button", { name: /^Xem tất cả \d+ thành viên$/ })));
	});

	it("closes only the member menu on the first Esc, then the dialog, and the confirm on its own", async () => {
		await openOps();
		const info = await screen.findByRole("complementary", { name: "Thông tin nhóm" }, LONG);
		await userEvent.click(await within(info).findByRole("button", { name: /^Xem tất cả \d+ thành viên$/ }, LONG));
		const members = await screen.findByRole("dialog", { name: /^Thành viên · \d+$/ }, LONG);
		await userEvent.click(await within(members).findByRole("button", { name: "Thao tác với Minh" }, LONG));
		await screen.findByRole("menu", { name: "Thao tác với Minh" });

		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("menu", { name: "Thao tác với Minh" })).toBeNull());
		expect(screen.getByRole("dialog", { name: /^Thành viên · \d+$/ })).toBeTruthy();

		await userEvent.click(within(members).getByRole("button", { name: "Thao tác với Minh" }));
		await userEvent.click(within(screen.getByRole("menu", { name: "Thao tác với Minh" })).getByRole("menuitem", { name: "Xoá khỏi nhóm" }));
		await screen.findByRole("dialog", { name: "Xoá Minh khỏi nhóm?" }, LONG);
		// Esc on the confirm goes back to the list, which Esc then closes.
		await userEvent.keyboard("{Escape}");
		await screen.findByRole("dialog", { name: /^Thành viên · \d+$/ }, LONG);
		expect(screen.queryByRole("dialog", { name: "Xoá Minh khỏi nhóm?" })).toBeNull();
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog", { name: /^Thành viên · \d+$/ })).toBeNull(), LONG);
	});
});
