// What members and admins see of a webhook's life after it is created
// (mockups/integrations.html#hook-disabled, #alert-grouping, #create-hook):
// the system line when a webhook stops, the bell-off mark of silent
// messages (which never play the in-chat sound), and editing a webhook's
// name, alert priority and silent sending.
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncomingHookDisabledReason, IncomingHookFormat } from "@achoo254/chat-proto/integrations";
import { setSoundInChat } from "../src/messaging/data/device-settings.ts";
import { navigate } from "../src/router.tsx";
import { seedDemo } from "./support/demo-data.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const playTone = vi.hoisted(() => vi.fn());
vi.mock("../src/messaging/data/sound.ts", () => ({ playTone }));

const LONG = { timeout: 8000 };

afterEach(() => {
	playTone.mockClear();
	window.localStorage.clear();
});

describe("a webhook that stops", () => {
	it("leaves a system line in the group, from the server or from the admin who stopped it", async () => {
		const demo = seedDemo();
		const fake = demo.fixture.integrations;
		const { ops, users } = demo.ids;
		const gitlab = fake.seed(ops, { name: "GitLab ops/deploy", createdBy: users.minh });
		const kuma = fake.seed(ops, { name: "Uptime Kuma", createdBy: users.minh });
		const grafana = fake.seed(ops, { name: "Grafana prod" });
		fake.autoDisable(gitlab);
		fake.autoDisable(kuma, IncomingHookDisabledReason.CREATOR_LEFT);
		renderMessaging(demo.fixture, `/c/${ops}`);

		const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
		expect(await within(log).findByText("Webhook “GitLab ops/deploy” đã tự tắt vì người tạo không còn là admin", {}, LONG)).toBeTruthy();
		const left = within(log).getByText("Webhook “Uptime Kuma” đã tự tắt vì người tạo đã rời nhóm");
		expect(left.className).toBe("system");
		// The chat list previews the latest one.
		const row = screen.getByRole("link", { name: /Vận hành hệ thống/ });
		expect(within(row).getByText("Webhook “Uptime Kuma” đã tự tắt vì người tạo đã rời nhóm")).toBeTruthy();

		// An admin turns one off on its page, then deletes it: each leaves a line naming them.
		act(() => navigate(`/c/${ops}/admin/hooks/${grafana}`));
		await screen.findByRole("heading", { name: "Grafana prod" }, LONG);
		await userEvent.click(screen.getByRole("switch", { name: "Nhận tin" }));
		await waitFor(() => expect(screen.getByRole("switch", { name: "Nhận tin" }).getAttribute("aria-checked")).toBe("false"));
		await userEvent.click(screen.getByRole("button", { name: "Xoá webhook" }));
		await userEvent.click(within(await screen.findByRole("dialog", { name: "Xoá webhook Grafana prod?" })).getByRole("button", { name: "Xoá webhook" }));
		await waitFor(() => expect(window.location.pathname).toBe(`/c/${ops}/admin/hooks`));

		act(() => navigate(`/c/${ops}`));
		const again = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
		expect(await within(again).findByText("Bạn đã tắt webhook “Grafana prod”", {}, LONG)).toBeTruthy();
		expect(await within(again).findByText("Bạn đã xoá webhook “Grafana prod”", {}, LONG)).toBeTruthy();
	});
});

describe("silent webhook messages", () => {
	it("carry the bell-off mark and never play the in-chat sound", async () => {
		const demo = seedDemo();
		const f = demo.fixture;
		const { ops } = demo.ids;
		setSoundInChat(f.selfId, true);
		renderMessaging(f, `/c/${ops}`);
		const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
		// Let the open chat settle: the first look only notes where it ends.
		await waitFor(() => expect(log.querySelectorAll(".msg").length).toBeGreaterThan(0), LONG);

		f.postIntegration(ops, "Jenkins build", "Build chat-server #318 thành công", { silent: true });
		const quiet = (await within(log).findByText("Tích hợp: Jenkins build", {}, LONG)).closest(".bubble") as HTMLElement;
		const mark = within(quiet).getByRole("img", { name: "Gửi im lặng, không thông báo" });
		expect(mark.className).toBe("silent-mark");
		expect(mark.closest(".stamp")).toBeTruthy();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(playTone).not.toHaveBeenCalled();

		f.postIntegration(ops, "Grafana prod", "Firing CPU cao trên lab-174");
		const loud = (await within(log).findByText("Tích hợp: Grafana prod", {}, LONG)).closest(".bubble") as HTMLElement;
		expect(within(loud).queryByRole("img", { name: "Gửi im lặng, không thông báo" })).toBeNull();
		await waitFor(() => expect(playTone).toHaveBeenCalledTimes(1));
	});
});

describe("editing a webhook", () => {
	it("changes its name, alert priority and silent sending, and logs what changed", async () => {
		const demo = seedDemo();
		const fake = demo.fixture.integrations;
		const { ops } = demo.ids;
		const hookId = fake.seed(ops, { name: "Jenkins", format: IncomingHookFormat.NATIVE });
		renderMessaging(demo.fixture, `/c/${ops}/admin/hooks/${hookId}`);
		await screen.findByRole("heading", { name: "Jenkins" }, LONG);

		await userEvent.click(screen.getByRole("button", { name: "Sửa cài đặt" }));
		const dialog = await screen.findByRole("dialog", { name: "Sửa webhook Jenkins" });
		// Saving unchanged settings sends nothing.
		await userEvent.click(within(dialog).getByRole("button", { name: "Lưu" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(fake.calls).toEqual([]);

		await userEvent.click(screen.getByRole("button", { name: "Sửa cài đặt" }));
		const form = await screen.findByRole("dialog", { name: "Sửa webhook Jenkins" });
		const name = within(form).getByRole("textbox", { name: "Tên" });
		await userEvent.clear(name);
		expect(within(form).getByText("Nhập tên webhook")).toBeTruthy();
		expect(within(form).getByRole("button", { name: "Lưu" }).hasAttribute("disabled")).toBe(true);
		await userEvent.type(name, "Jenkins build");
		await userEvent.click(within(form).getByRole("switch", { name: "Cho phép tin ưu tiên Cảnh báo" }));
		await userEvent.click(within(form).getByRole("switch", { name: "Gửi im lặng" }));
		// The format is part of the URL: shown, not editable.
		expect(within(form).getByText(/^Định dạng Native JSON gắn với URL nên không đổi được\./)).toBeTruthy();
		await userEvent.click(within(form).getByRole("button", { name: "Lưu" }));

		expect(await screen.findByText("Đã lưu cài đặt của Jenkins build", {}, LONG)).toBeTruthy();
		expect(await screen.findByRole("heading", { name: "Jenkins build" })).toBeTruthy();
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(fake.calls).toEqual([`UpdateIncomingHook ${hookId}`]);
		expect(fake.hooks.get(hookId)).toMatchObject({ name: "Jenkins build", allowAlert: true, silent: true, format: IncomingHookFormat.NATIVE });
		const facts = screen.getByText("Gửi im lặng", { selector: "dt" }).closest("div") as HTMLElement;
		expect(within(facts).getByText("Bật")).toBeTruthy();
		expect(
			await screen.findByText("Bạn đã sửa Jenkins build: đổi tên “Jenkins” thành “Jenkins build”, cho phép tin Cảnh báo, bật gửi im lặng", {}, LONG),
		).toBeTruthy();
	});

	it("keeps the dialog open when saving fails", async () => {
		const demo = seedDemo();
		const fake = demo.fixture.integrations;
		const hookId = fake.seed(demo.ids.ops, { name: "Jenkins" });
		renderMessaging(demo.fixture, `/c/${demo.ids.ops}/admin/hooks/${hookId}`);
		await screen.findByRole("heading", { name: "Jenkins" }, LONG);
		await userEvent.click(screen.getByRole("button", { name: "Sửa cài đặt" }));
		const form = await screen.findByRole("dialog", { name: "Sửa webhook Jenkins" });
		await userEvent.click(within(form).getByRole("switch", { name: "Gửi im lặng" }));
		// Another admin deleted it meanwhile.
		fake.hooks.delete(hookId);
		await userEvent.click(within(form).getByRole("button", { name: "Lưu" }));
		expect(await screen.findByText("Không thực hiện được, thử lại sau ít phút.", {}, LONG)).toBeTruthy();
		expect(screen.getByRole("dialog", { name: "Sửa webhook Jenkins" })).toBeTruthy();
		expect(within(form).getByRole("button", { name: "Lưu" }).hasAttribute("disabled")).toBe(false);
	});
});
