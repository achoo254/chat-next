import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import type { MessageEntity } from "@app/core";
import type { Hook } from "../src/messaging/integrations/api.ts";
import { enHooks } from "../src/messaging/integrations/copy-en.ts";
import { viHooks } from "../src/messaging/integrations/copy-vi.ts";
import { chatSlug } from "../src/messaging/integrations/hook-guide.tsx";
import { countdown, formatLabel, hookErrorCode, stateView } from "../src/messaging/integrations/hook-parts.tsx";
import { guideSnippet, sampleCommand, samplePayload, sampleResponse, shellQuote } from "../src/messaging/integrations/samples.ts";
import { integrationTone } from "../src/messaging/data/format.ts";
import { sliceRich, splitAlert } from "../src/messaging/ui/alert-text.ts";
import { matchRoute, paths } from "../src/router.tsx";

const bold = (offset: number, length: number): MessageEntity => ({ type: "bold", offset, length });

describe("alert text", () => {
	it("turns a leading Firing or Resolved into the status, title and body", () => {
		const text = "Firing DiskFull trên db-02\n📊 Giá trị: 94%\ndf -h";
		const pre = text.indexOf("df -h");
		const parts = splitAlert(text, [bold(0, 6), { type: "pre", offset: pre, length: 5, language: "sh" }]);
		expect(parts?.status).toBe("firing");
		expect(parts?.title).toEqual({ text: "DiskFull trên db-02", entities: [] });
		expect(parts?.body.text).toBe("📊 Giá trị: 94%\ndf -h");
		// Offsets move with the cut (UTF-16 units: the emoji counts 2).
		expect(parts?.body.entities).toEqual([{ type: "pre", offset: 16, length: 5, language: "sh" }]);
		expect(splitAlert("resolved ok", [])?.status).toBe("resolved");
		expect(splitAlert("RESOLVED", [])).toEqual({ status: "resolved", title: { text: "", entities: [] }, body: { text: "", entities: [] } });
	});

	it("leaves other texts alone", () => {
		expect(splitAlert("Firingly hot", [])).toBeNull();
		expect(splitAlert("Pipeline #5121 firing", [])).toBeNull();
		expect(splitAlert("", [])).toBeNull();
	});

	it("clips entities that cross a cut", () => {
		expect(sliceRich("abcdef", [bold(1, 4)], 3, 6)).toEqual({ text: "def", entities: [bold(0, 2)] });
		expect(sliceRich("abcdef", [bold(0, 2)], 3, 6)).toEqual({ text: "def", entities: [] });
	});
});

describe("webhook samples", () => {
	const url = "https://chat.example.test/hook/hk_abc/S3cret/slack";

	it("quotes for the shell, single quotes included", () => {
		expect(shellQuote("it's")).toBe(`'it'\\''s'`);
		expect(sampleCommand("slack", url, "Xin chào từ Kuma's")).toContain(`-d '{"text":"Xin chào từ Kuma'\\''s"}'`);
	});

	it("posts what each format parses, and says what comes back", () => {
		expect(sampleCommand("slack", url, "Hi")).toBe(`curl -X POST '${url}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"text":"Hi"}'`);
		expect(samplePayload("native", "Hi")).toEqual({ text: "Hi" });
		expect(samplePayload("alertmanager", "Hi")).toMatchObject({ status: "firing", groupKey: "test-webhook", alerts: [{ annotations: { summary: "Hi" } }] });
		expect(samplePayload("grafana", "Hi")).toMatchObject({ title: "[FIRING:1] TestWebhook", message: "Hi" });
		expect(samplePayload("gitlab", "Hi")).toMatchObject({ object_kind: "push", commits: [{ title: "Hi" }] });
		expect(sampleCommand("gitlab", url, "Hi")).toContain("-H 'X-Gitlab-Event: Push Hook'");
		expect(sampleResponse("slack")).toBe("ok");
		expect(sampleResponse("native")).toBe('{"chat_id": …, "seq": …}');
		expect(guideSnippet("alertmanager", "chat-van-hanh")).toContain('- url: "{URL}"');
		expect(guideSnippet("grafana", "chat-van-hanh")).toContain("type: webhook");
	});

	it("names a config after the chat in ASCII", () => {
		expect(chatSlug("Vận hành hệ thống")).toBe("chat-van-hanh-he-thong");
		expect(chatSlug("🔥🔥")).toBe("chat");
	});
});

describe("webhook state", () => {
	const now = 1_760_400_000;
	const hook: Hook = {
		id: "hk_a",
		chatId: 1,
		name: "Grafana prod",
		format: "slack",
		allowAlert: false,
		silent: false,
		createdBy: 2,
		createdAt: now - 86_400,
		state: "active",
		disabledReason: "none",
		disabledAt: 0,
		lastUsedAt: 0,
		secretCreatedAt: now - 3600,
		secretCreatedBy: 2,
		previousSecretExpiresAt: 0,
	};

	it("describes running, rotating, silent and turned-off hooks", () => {
		expect(stateView(hook, now, viHooks, false)).toEqual({ label: "Hoạt động", tone: "ok", sub: "" });
		expect(stateView({ ...hook, silent: true }, now, viHooks, false).sub).toBe("Gửi im lặng");
		expect(stateView({ ...hook, previousSecretExpiresAt: now + 6 * 86_400 + 5 }, now, viHooks, false)).toEqual({
			label: "Đang xoay secret",
			tone: "warn",
			sub: "URL cũ hết hạn sau 6 ngày",
		});
		expect(stateView({ ...hook, previousSecretExpiresAt: now + 90 }, now, viHooks, false).sub).toBe("URL cũ hết hạn sau 1 giờ");
		expect(stateView({ ...hook, state: "auto_disabled", disabledReason: "creator_left" }, now, viHooks, true)).toEqual({
			label: "Đã tự tắt",
			tone: "err",
			sub: "Người tạo đã rời kênh",
		});
		expect(stateView({ ...hook, state: "disabled", disabledReason: "by_admin" }, now, viHooks, false).tone).toBe("off");
	});

	it("counts the grace period down to the second", () => {
		expect(countdown(6 * 86_400 + 23 * 3600 + 47 * 60 + 58, viHooks)).toBe("6 ngày 23:47:58");
		expect(countdown(59, viHooks)).toBe("00:00:59");
		expect(countdown(-5, viHooks)).toBe("00:00:00");
		expect(countdown(86_400, enHooks)).toBe("1 day 00:00:00");
	});

	it("labels formats with their URL suffix", () => {
		expect(formatLabel("native", viHooks)).toBe("Native JSON");
		expect(formatLabel("alertmanager", viHooks)).toBe("Alertmanager · /alertmanager");
	});

	it("reads the server's precondition tags", () => {
		expect(hookErrorCode(new ConnectError("hooks_limit: a chat has at most 20 webhooks", Code.FailedPrecondition))).toBe("hooks_limit");
		expect(hookErrorCode(new ConnectError("creator_not_admin: take it over", Code.FailedPrecondition))).toBe("creator_not_admin");
		expect(hookErrorCode(new ConnectError("no_previous_secret: none", Code.FailedPrecondition))).toBe("no_previous_secret");
		expect(hookErrorCode(new ConnectError("something else", Code.FailedPrecondition))).toBe("other");
		expect(hookErrorCode(new ConnectError("gone", Code.NotFound))).toBe("not_found");
		expect(hookErrorCode(new Error("network"))).toBe("other");
	});

	it("keeps one colour per integration name", () => {
		expect(integrationTone("Grafana prod")).toBe(integrationTone("Grafana prod"));
	});
});

describe("webhook routes and copy", () => {
	it("opens the list, the form and one hook", () => {
		expect(matchRoute(paths.hooks(5001))).toEqual({ name: "chat", chatId: 5001, topicId: 0, panel: "hooks" });
		expect(matchRoute(paths.hookNew(5001))).toEqual({ name: "chat", chatId: 5001, topicId: 0, panel: "hook-new" });
		expect(matchRoute(paths.hook(5001, "hk_7Qm2xRabcdEf"))).toEqual({ name: "chat", chatId: 5001, topicId: 0, panel: "hook", hookId: "hk_7Qm2xRabcdEf" });
		expect(matchRoute("/c/5001/admin/hooks/../x")).toBeNull();
		expect(matchRoute("/c/5001/admin/hooks/hk_bad id")).toBeNull();
		expect(matchRoute("/c/5001/admin/hooks/hk_a/more")).toBeNull();
	});

	it("has the same keys in Vietnamese and English", () => {
		const keys = (value: object, prefix = ""): string[] =>
			Object.entries(value).flatMap(([key, child]) =>
				child !== null && typeof child === "object" && !Array.isArray(child) ? keys(child as object, `${prefix}${key}.`) : [`${prefix}${key}`],
			);
		expect(keys(enHooks).sort()).toEqual(keys(viHooks).sort());
		expect(enHooks.guides.alertmanager).toHaveLength(viHooks.guides.alertmanager.length);
	});
});
