// Incoming webhooks (mockups/integrations.html) through the real client
// core, the in-memory server and the fake IntegrationsService: managing
// hooks as an admin (create with the one-time URL, rotate and revoke the
// old secret, turn off and on, take over, delete, counters, dead letters,
// log) and how their messages render in the chat (label, Firing/Resolved,
// code blocks, URL buttons, alerts updated in place).
import { ChatType, MemberRole } from "@app/proto-ts/chats";
import { IncomingHookAuditAction, IncomingHookDisabledReason, IncomingHookFormat, IncomingHookState } from "@app/proto-ts/integrations";
import { EntityType } from "@app/proto-ts/messages";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { entity, seedDemo } from "./support/demo-data.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const LONG = { timeout: 8000 };

async function openHooks(path: (ids: ReturnType<typeof seedDemo>["ids"]) => string, demo = seedDemo()) {
	renderMessaging(demo.fixture, path(demo.ids));
	return demo;
}

describe("webhook management", () => {
	it("creates a webhook and shows its URL once, with a curl command for the format", async () => {
		const demo = await openHooks((ids) => `/c/${ids.ops}/admin/hooks`);
		const fake = demo.fixture.integrations;
		expect(await screen.findByText("Chưa có webhook", {}, LONG)).toBeTruthy();

		await userEvent.click(screen.getByRole("link", { name: "Tạo webhook" }));
		expect(window.location.pathname).toBe(`/c/${demo.ids.ops}/admin/hooks/new`);
		const form = await screen.findByRole("form", { name: "Tạo webhook" }, LONG);
		// An empty name is refused before any request.
		await userEvent.click(within(form).getByRole("button", { name: "Tạo webhook" }));
		expect(within(form).getByText("Nhập tên webhook")).toBeTruthy();
		expect(fake.calls).toEqual([]);

		await userEvent.type(within(form).getByRole("textbox", { name: "Tên" }), "Alertmanager prod");
		await userEvent.click(within(form).getByRole("radio", { name: /^Alertmanager · \/alertmanager/ }));
		await userEvent.click(within(form).getByRole("switch", { name: "Gửi im lặng" }));
		// The preview shows the label members will see.
		expect(screen.getByText("Tích hợp: Alertmanager prod")).toBeTruthy();
		await userEvent.click(within(form).getByRole("button", { name: "Tạo webhook" }));

		const dialog = await screen.findByRole("dialog", { name: "Đã tạo webhook Alertmanager prod" }, LONG);
		const hookId = [...fake.hooks.keys()][0] ?? "";
		const url = fake.urlOf(hookId);
		expect(url).toMatch(/\/alertmanager$/);
		expect(fake.hooks.get(hookId)?.silent).toBe(true);
		expect(fake.hooks.get(hookId)?.format).toBe(IncomingHookFormat.ALERTMANAGER);
		// The full URL is in the dialog (middle-truncated on screen) and in the curl command.
		expect(within(dialog).getByTitle(url)).toBeTruthy();
		const command = within(dialog).getByText((_, element) => element?.tagName === "PRE" && (element.textContent ?? "").startsWith("curl -X POST"));
		expect(command.textContent).toContain(`'${url}'`);
		expect(command.textContent).toContain('"groupKey": "test-webhook"');
		expect(within(dialog).getByText('Phản hồi: {"chat_id": …, "seq": …}')).toBeTruthy();

		// "Xong" waits for "Tôi đã lưu URL".
		const done = within(dialog).getByRole("button", { name: "Xong" });
		expect(done.hasAttribute("disabled")).toBe(true);
		await userEvent.click(within(dialog).getByRole("switch", { name: "Tôi đã lưu URL" }));
		await userEvent.click(done);
		await waitFor(() => expect(window.location.pathname).toBe(`/c/${demo.ids.ops}/admin/hooks/${hookId}`));
		expect(await screen.findByRole("heading", { name: "Alertmanager prod" }, LONG)).toBeTruthy();
		// Gone from the page once closed; nothing kept in storage either.
		expect(screen.queryByTitle(url)).toBeNull();
		expect(document.body.innerHTML).not.toContain(fake.secrets.get(hookId) ?? "missing");
		expect(JSON.stringify({ ...window.localStorage })).not.toContain(fake.secrets.get(hookId) ?? "missing");
		expect(fake.calls).toEqual([`CreateIncomingHook ${demo.ids.ops}`]);
	});

	it("lists hooks with their state and refuses a 21st", async () => {
		const demo = seedDemo();
		const fake = demo.fixture.integrations;
		const { ops, users } = demo.ids;
		fake.seed(ops, { name: "Grafana prod", lastUsedAt: fake.now - 60 });
		fake.seed(ops, { name: "Alertmanager prod", format: IncomingHookFormat.ALERTMANAGER, graceLeft: 6 * 86_400 + 3600 });
		const gitlab = fake.seed(ops, { name: "GitLab ops/deploy", createdBy: users.minh });
		fake.autoDisable(gitlab);
		fake.seed(ops, { name: "Jenkins build", format: IncomingHookFormat.NATIVE, silent: true });
		renderMessaging(demo.fixture, `/c/${ops}/admin/hooks`);

		const table = await screen.findByRole("table", {}, LONG);
		const row = (name: string) => within(table).getByText(name).closest("tr") as HTMLElement;
		await within(table).findByText("Jenkins build", {}, LONG);
		expect(within(row("Grafana prod")).getByText("Hoạt động")).toBeTruthy();
		expect(within(row("Grafana prod")).getByText("Slack-compatible · /slack")).toBeTruthy();
		expect(within(row("Grafana prod")).getByText("Bạn")).toBeTruthy();
		expect(within(row("Alertmanager prod")).getByText("Đang xoay secret")).toBeTruthy();
		expect(within(row("Alertmanager prod")).getByText("URL cũ hết hạn sau 6 ngày")).toBeTruthy();
		expect(within(row("GitLab ops/deploy")).getByText("Đã tự tắt")).toBeTruthy();
		expect(within(row("GitLab ops/deploy")).getByText("Người tạo không còn là admin")).toBeTruthy();
		expect(within(row("GitLab ops/deploy")).getByText("Minh")).toBeTruthy();
		expect(within(row("Jenkins build")).getByText("Gửi im lặng")).toBeTruthy();
		expect(within(row("Jenkins build")).getByText("Chưa nhận")).toBeTruthy();
		// The chat's log names the server for the automatic turn-off.
		expect(await screen.findByText("GitLab ops/deploy đã tự tắt: người tạo không còn là admin", {}, LONG)).toBeTruthy();

		for (let i = 0; i < 16; i++) fake.seed(ops, { name: `Hook ${i}` });
		await userEvent.click(within(row("Grafana prod")).getByRole("link", { name: "Quản lý webhook Grafana prod" }));
		await screen.findByRole("heading", { name: "Grafana prod" }, LONG);
		await userEvent.click(screen.getByRole("link", { name: "Về danh sách webhook" }));
		expect(await screen.findByText(/^Đã đủ 20 webhook/, {}, LONG)).toBeTruthy();
		expect(screen.queryByRole("link", { name: "Tạo webhook" })).toBeNull();
	});

	it("rotates the secret with a grace period, then revokes the old one", async () => {
		const demo = seedDemo();
		const fake = demo.fixture.integrations;
		const hookId = fake.seed(demo.ids.ops, { name: "Alertmanager prod", format: IncomingHookFormat.ALERTMANAGER });
		const oldUrl = fake.urlOf(hookId);
		renderMessaging(demo.fixture, `/c/${demo.ids.ops}/admin/hooks/${hookId}`);
		await screen.findByRole("heading", { name: "Alertmanager prod" }, LONG);
		expect(screen.queryByText("Secret cũ")).toBeNull();

		await userEvent.click(screen.getByRole("button", { name: "Xoay secret" }));
		const confirm = await screen.findByRole("dialog", { name: "Xoay secret của Alertmanager prod?" });
		expect(within(confirm).getByRole("switch", { name: "Thu hồi URL cũ ngay" }).getAttribute("aria-checked")).toBe("false");
		await userEvent.click(within(confirm).getByRole("button", { name: "Xoay secret" }));

		const once = await screen.findByRole("dialog", { name: "URL mới của Alertmanager prod" }, LONG);
		const newUrl = fake.urlOf(hookId);
		expect(newUrl).not.toBe(oldUrl);
		expect(within(once).getByTitle(newUrl)).toBeTruthy();
		await userEvent.click(within(once).getByRole("switch", { name: "Tôi đã lưu URL" }));
		await userEvent.click(within(once).getByRole("button", { name: "Xong" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

		// The old secret keeps working for 7 days.
		expect(screen.getByText("Secret cũ")).toBeTruthy();
		expect(screen.getByRole("progressbar", { name: "Thời gian ân hạn đã qua" })).toBeTruthy();
		expect(screen.getByText("Đang xoay secret")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Thu hồi secret cũ ngay" }));
		await waitFor(() => expect(screen.queryByText("Secret cũ")).toBeNull());
		expect(screen.getByText("Đã thu hồi secret cũ, chỉ URL mới còn hiệu lực")).toBeTruthy();
		expect(fake.calls).toEqual([`RotateIncomingHookSecret ${hookId}`, `RevokePreviousHookSecret ${hookId}`]);
		expect(await screen.findByText("Bạn đã thu hồi secret cũ của Alertmanager prod", {}, LONG)).toBeTruthy();
	});

	it("turns a webhook off and on, and offers the take-over when its creator is no longer an admin", async () => {
		const demo = seedDemo();
		const fake = demo.fixture.integrations;
		const { ops, users } = demo.ids;
		const mine = fake.seed(ops, { name: "Grafana prod" });
		renderMessaging(demo.fixture, `/c/${ops}/admin/hooks/${mine}`);
		await screen.findByRole("heading", { name: "Grafana prod" }, LONG);

		const receiving = screen.getByRole("switch", { name: "Nhận tin" });
		expect(receiving.getAttribute("aria-checked")).toBe("true");
		await userEvent.click(receiving);
		expect(await screen.findByText(/^Webhook đang tắt từ /, {}, LONG)).toBeTruthy();
		await waitFor(() => expect(screen.getByRole("switch", { name: "Nhận tin" }).getAttribute("aria-checked")).toBe("false"));
		await userEvent.click(screen.getByRole("switch", { name: "Nhận tin" }));
		await waitFor(() => expect(screen.getByRole("switch", { name: "Nhận tin" }).getAttribute("aria-checked")).toBe("true"));
		expect(screen.queryByText(/^Webhook đang tắt từ /)).toBeNull();
		expect(fake.calls).toEqual([`SetIncomingHookEnabled ${mine} off`, `SetIncomingHookEnabled ${mine} on`]);

		// Minh is a plain member: his turned-off webhook cannot be turned back on, only taken over.
		const minhs = fake.seed(ops, { name: "GitLab ops/deploy", createdBy: users.minh, state: IncomingHookState.DISABLED });
		await userEvent.click(screen.getByRole("link", { name: "Về danh sách webhook" }));
		await userEvent.click(await screen.findByRole("link", { name: "Quản lý webhook GitLab ops/deploy" }, LONG));
		await screen.findByRole("heading", { name: "GitLab ops/deploy" }, LONG);
		expect(screen.queryByRole("heading", { name: "Nhận lại webhook" })).toBeNull();
		await userEvent.click(screen.getByRole("switch", { name: "Nhận tin" }));
		expect(await screen.findByText("Người tạo không còn là admin. Nhận lại webhook để bật.", {}, LONG)).toBeTruthy();
		expect(screen.getByRole("heading", { name: "Nhận lại webhook" })).toBeTruthy();
		expect(fake.hooks.get(minhs)?.state).toBe(IncomingHookState.DISABLED);
	});

	it("takes over a webhook the server turned off, keeping the URL or with a new one", async () => {
		const demo = seedDemo();
		const fake = demo.fixture.integrations;
		const { ops, users } = demo.ids;
		const keep = fake.seed(ops, { name: "GitLab ops/deploy", createdBy: users.minh, format: IncomingHookFormat.GITLAB });
		fake.autoDisable(keep);
		const rotate = fake.seed(ops, { name: "Uptime Kuma", createdBy: users.minh });
		fake.autoDisable(rotate, IncomingHookDisabledReason.CREATOR_LEFT);
		const keptUrl = fake.urlOf(keep);
		renderMessaging(demo.fixture, `/c/${ops}/admin/hooks/${keep}`);

		await screen.findByRole("heading", { name: "GitLab ops/deploy" }, LONG);
		expect(screen.getByText(/^Webhook đã tự tắt vì Minh không còn là admin nhóm \(.+\)\. Request tới URL này đang bị từ chối\.$/)).toBeTruthy();
		// No on/off switch while the server keeps it off.
		expect(screen.queryByRole("switch", { name: "Nhận tin" })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "Nhận lại webhook" }));
		expect(await screen.findByText("Đã nhận lại webhook, URL giữ nguyên", {}, LONG)).toBeTruthy();
		await waitFor(() => expect(screen.queryByRole("heading", { name: "Nhận lại webhook" })).toBeNull());
		expect(screen.getByRole("switch", { name: "Nhận tin" }).getAttribute("aria-checked")).toBe("true");
		expect(fake.urlOf(keep)).toBe(keptUrl);
		expect(screen.queryByRole("dialog")).toBeNull();

		await userEvent.click(screen.getByRole("link", { name: "Về danh sách webhook" }));
		await userEvent.click(await screen.findByRole("link", { name: "Quản lý webhook Uptime Kuma" }, LONG));
		await screen.findByRole("heading", { name: "Uptime Kuma" }, LONG);
		expect(screen.getByText(/^Webhook đã tự tắt vì Minh đã rời nhóm/)).toBeTruthy();
		await userEvent.click(screen.getByRole("switch", { name: "Xoay secret khi nhận lại" }));
		await userEvent.click(screen.getByRole("button", { name: "Nhận lại webhook" }));
		const once = await screen.findByRole("dialog", { name: "URL mới của Uptime Kuma" }, LONG);
		expect(within(once).getByTitle(fake.urlOf(rotate))).toBeTruthy();
		expect(fake.calls).toEqual([`TakeOverIncomingHook ${keep}`, `TakeOverIncomingHook ${rotate} rotate`]);
	});

	it("deletes a webhook after confirmation", async () => {
		const demo = seedDemo();
		const fake = demo.fixture.integrations;
		const hookId = fake.seed(demo.ids.ops, { name: "Jenkins build", format: IncomingHookFormat.NATIVE });
		renderMessaging(demo.fixture, `/c/${demo.ids.ops}/admin/hooks/${hookId}`);
		await screen.findByRole("heading", { name: "Jenkins build" }, LONG);

		await userEvent.click(screen.getByRole("button", { name: "Xoá webhook" }));
		const dialog = await screen.findByRole("dialog", { name: "Xoá webhook Jenkins build?" });
		await userEvent.click(within(dialog).getByRole("button", { name: "Huỷ" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(fake.hooks.has(hookId)).toBe(true);

		await userEvent.click(screen.getByRole("button", { name: "Xoá webhook" }));
		await userEvent.click(within(await screen.findByRole("dialog", { name: "Xoá webhook Jenkins build?" })).getByRole("button", { name: "Xoá webhook" }));
		await waitFor(() => expect(window.location.pathname).toBe(`/c/${demo.ids.ops}/admin/hooks`));
		expect(fake.hooks.has(hookId)).toBe(false);
		expect(await screen.findByText("Đã xoá webhook Jenkins build", {}, LONG)).toBeTruthy();
		// The chat's log keeps deleted webhooks.
		expect(await screen.findByText("Bạn đã xoá Jenkins build", {}, LONG)).toBeTruthy();
		expect(fake.calls).toEqual([`DeleteIncomingHook ${hookId}`]);
	});

	it("shows counters, failures by reason, failed requests with their bodies and the log, a page at a time", async () => {
		const demo = seedDemo();
		const fake = demo.fixture.integrations;
		const hookId = fake.seed(demo.ids.ops, { name: "Grafana prod", format: IncomingHookFormat.GRAFANA });
		fake.counters.set(hookId, {
			accepted: 1284,
			delivered: 1201,
			failures: [
				{ reason: "rate_limited", count: 3, lastAt: fake.now - 120 },
				{ reason: "payload_too_large", count: 2, lastAt: fake.now - 3600 },
			],
		});
		for (let i = 0; i < 25; i++) fake.addDeadLetter(hookId, "invalid_json", `unexpected end of JSON input #${i}`, `{"text": "broken ${i}"`);
		fake.seedAudit(hookId, [{ actorId: demo.ids.users.lan, action: IncomingHookAuditAction.CREATED, detail: "grafana", ago: 86_400 }]);
		renderMessaging(demo.fixture, `/c/${demo.ids.ops}/admin/hooks/${hookId}`);
		await screen.findByRole("heading", { name: "Grafana prod" }, LONG);

		const stats = screen.getByRole("region", { name: "Số liệu" });
		expect(await within(stats).findByText("1.284", {}, LONG)).toBeTruthy();
		expect(within(stats).getByText("1.201")).toBeTruthy();
		expect(within(stats).getByText("5")).toBeTruthy();
		expect(within(stats).getByText("Vượt rate limit")).toBeTruthy();
		expect(within(stats).getByText("Payload lớn hơn 64 KB")).toBeTruthy();

		const dead = screen.getByRole("region", { name: "Request lỗi" });
		await within(dead).findByText("unexpected end of JSON input #24", {}, LONG);
		expect(within(dead).getAllByText("JSON sai định dạng")).toHaveLength(20);
		expect(within(dead).getByText('{"text": "broken 24"')).toBeTruthy();
		await userEvent.click(within(dead).getByRole("button", { name: "Xem thêm" }));
		await waitFor(() => expect(within(dead).getAllByText("JSON sai định dạng")).toHaveLength(25));
		expect(within(dead).queryByRole("button", { name: "Xem thêm" })).toBeNull();

		const log = screen.getByRole("region", { name: "Nhật ký" });
		expect(await within(log).findByText("Lan Anh đã tạo Grafana prod", {}, LONG)).toBeTruthy();
		// The format guide uses the hook's format.
		const guide = screen.getByRole("region", { name: "Hướng dẫn kết nối" });
		expect(within(guide).getByText(/type: webhook/)).toBeTruthy();
	});

	it("is for admins only", async () => {
		const demo = seedDemo();
		const f = demo.fixture;
		const plain = f.createChat(ChatType.GROUP, "Nhóm thường", [f.selfId, demo.ids.users.minh], { myRole: MemberRole.MEMBER });
		f.send(demo.ids.users.minh, plain, "Chào");
		renderMessaging(f, `/c/${plain}/admin/hooks`);
		expect(await screen.findByText("Chỉ admin của nhóm hoặc kênh quản lý được webhook.", {}, LONG)).toBeTruthy();
		expect(f.integrations.calls).toEqual([]);
	});

	it("is reachable from the admin page, which counts the running webhooks", async () => {
		const demo = seedDemo();
		const fake = demo.fixture.integrations;
		fake.seed(demo.ids.ops, { name: "Grafana prod" });
		fake.seed(demo.ids.ops, { name: "Jenkins build", state: IncomingHookState.DISABLED });
		renderMessaging(demo.fixture, `/c/${demo.ids.ops}/admin`);
		const link = await screen.findByRole("link", { name: /^Webhook tích hợp/ }, LONG);
		await within(link).findByText("1 đang chạy: Grafana prod", {}, LONG);
		await userEvent.click(link);
		expect(window.location.pathname).toBe(`/c/${demo.ids.ops}/admin/hooks`);
		expect(await screen.findByRole("heading", { name: "Webhook của nhóm" }, LONG)).toBeTruthy();
	});
});

describe("a webhook the moderation team turned off", () => {
	it("says so and offers no way to turn it back on", async () => {
		const demo = seedDemo();
		const fake = demo.fixture.integrations;
		const hookId = fake.seed(demo.ids.ops, {
			name: "CI Alerts",
			state: IncomingHookState.DISABLED,
			disabledReason: IncomingHookDisabledReason.BY_MODERATOR,
		});
		renderMessaging(demo.fixture, `/c/${demo.ids.ops}/admin/hooks/${hookId}`);
		expect(await screen.findByText(/^Đội kiểm duyệt đã tắt webhook này lúc .+\. Admin không bật lại hay nhận lại được\.$/, {}, LONG)).toBeTruthy();
		expect(screen.queryByRole("switch", { name: "Nhận tin" })).toBeNull();
		expect(screen.queryByRole("button", { name: /Nhận lại/ })).toBeNull();
	});
});

describe("webhook messages", () => {
	it("render the label, the alert state, code blocks and URL buttons, and update in place", async () => {
		const demo = seedDemo();
		const f = demo.fixture;
		const { ops } = demo.ids;
		const text =
			"Firing Ổ đĩa sắp đầy trên db-02\n🖥️ Máy chủ: db-02.example.invalid\n📊 Đã dùng: 94% (ngưỡng 90%)\ndf -h /var/lib/postgresql";
		const seq = f.postIntegration(ops, "Giám sát máy chủ", text, {
			entities: [entity(EntityType.BOLD, text, "Firing"), entity(EntityType.PRE, text, "df -h /var/lib/postgresql", { language: "Kiểm tra nhanh" })],
			buttons: [[{ text: "Mở runbook", url: "https://runbook.example.com/disk" }], [{ text: "Bỏ qua", url: "javascript:alert(1)" }]],
		});
		renderMessaging(f, `/c/${ops}`);
		const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
		const label = await within(log).findByText("Tích hợp: Giám sát máy chủ", {}, LONG);
		const bubble = label.closest(".bubble") as HTMLElement;
		expect(bubble.className).toBe("bubble integration firing");
		expect(within(bubble).getByText("Firing").className).toBe("sev firing");
		expect(within(bubble).getByText("Ổ đĩa sắp đầy trên db-02")).toBeTruthy();
		// Field lines stay as sent; the code block has its own copy button and title.
		expect(within(bubble).getByText(/🖥️ Máy chủ: db-02\.example\.invalid\s+📊 Đã dùng: 94% \(ngưỡng 90%\)/)).toBeTruthy();
		expect(within(bubble).getByText("Kiểm tra nhanh")).toBeTruthy();
		expect(within(bubble).getByRole("button", { name: "Sao chép đoạn code" })).toBeTruthy();
		// Only allowed schemes become buttons; an external link asks first.
		expect(within(bubble).queryByText("Bỏ qua")).toBeNull();
		await userEvent.click(within(bubble).getByRole("link", { name: /Mở runbook/ }));
		const confirm = await screen.findByRole("dialog", { name: "Mở link ngoài?" });
		expect(within(confirm).getByText("runbook.example.com")).toBeTruthy();
		await userEvent.click(within(confirm).getByRole("button", { name: "Huỷ" }));
		// The sender's avatar is the integration's, not a person's profile.
		expect(bubble.closest(".msg")?.querySelector(".avatar-btn")).toBeNull();
		// The chat list names the integration as the sender.
		const row = screen.getByRole("link", { name: /Vận hành hệ thống/ });
		expect(within(row).getByText("Giám sát máy chủ:")).toBeTruthy();

		// Resolved: the same message changes in place, marked "đã cập nhật", not "đã sửa".
		const resolved = "Resolved Ổ đĩa sắp đầy trên db-02\n📊 Đã dùng: 71%";
		f.editIntegration(ops, seq, resolved, true, [entity(EntityType.BOLD, resolved, "Resolved")]);
		await within(log).findByText("Resolved", {}, LONG);
		const updated = within(log).getByText("Tích hợp: Giám sát máy chủ").closest(".bubble") as HTMLElement;
		expect(updated.className).toBe("bubble integration resolved");
		expect(within(updated).getByText(/^đã cập nhật \d\d:\d\d$/)).toBeTruthy();
		expect(within(updated).queryByText(/đã sửa/)).toBeNull();
		expect(within(log).getAllByText("Tích hợp: Giám sát máy chủ")).toHaveLength(1);
	});

	it("keeps a message without a status word as plain text, also when loaded from history", async () => {
		const demo = seedDemo();
		const f = demo.fixture;
		f.postIntegration(demo.ids.ops, "Jenkins build", "Build chat-server #318 thành công", { silent: true });
		// A later message: the webhook's one comes from history, not as the chat's last message.
		f.send(demo.ids.users.lan, demo.ids.ops, "Build xanh rồi");
		renderMessaging(f, `/c/${demo.ids.ops}`);
		const log = await screen.findByRole("log", { name: "Tin nhắn" }, LONG);
		const label = await within(log).findByText("Tích hợp: Jenkins build", {}, LONG);
		const bubble = label.closest(".bubble") as HTMLElement;
		expect(bubble.className).toBe("bubble integration");
		expect(within(bubble).getByText("Build chat-server #318 thành công")).toBeTruthy();
		expect(bubble.querySelector(".sev")).toBeNull();
	});
});
