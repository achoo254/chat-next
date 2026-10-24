// The per-type notification rules on their own (data/notification-filter.ts).
import { describe, expect, it } from "vitest";
import { DEFAULT_NOTIFICATION_SETTINGS, MUTE_FOREVER, type Chat, type DialogView, type NotificationSettings } from "@achoo254/chat-core";
import { decideNotification } from "../src/messaging/data/notification-filter.ts";
import { messagePreview } from "../src/messaging/data/format.ts";
import { vi as copy } from "../src/messaging/copy/vi.ts";

const NOW = 1_760_500_000;
const HIDDEN = "Bạn có tin nhắn mới";
const request = { title: "Vận hành hệ thống", body: "Lan Anh: Dashboard ổn định.", tag: "chat:7", chatId: 7 };

function view(type: Chat["type"] | null, muteUntil = 0): DialogView {
	const chat =
		type === null
			? null
			: ({ id: 7, type, title: "Vận hành hệ thống", peerUserId: 0, forum: false } as unknown as Chat);
	// Only the fields the rules read are filled in.
	return { chat, peer: null, topMessage: null, dialog: { chatId: 7, muteUntil } } as unknown as DialogView;
}

const settings = (change: Partial<NotificationSettings> = {}): NotificationSettings => ({ ...DEFAULT_NOTIFICATION_SETTINGS, ...change });

describe("decideNotification", () => {
	it("shows the message with the system sound by default", () => {
		expect(decideNotification(request, view("group"), settings(), NOW, HIDDEN)).toEqual({ ...request, silent: false });
	});

	it("follows the switch of the chat's type", () => {
		const off = settings({ groupsEnabled: false });
		expect(decideNotification(request, view("group"), off, NOW, HIDDEN)).toBeNull();
		expect(decideNotification(request, view("private"), off, NOW, HIDDEN)).not.toBeNull();
		expect(decideNotification(request, view("channel"), settings({ channelsEnabled: false }), NOW, HIDDEN)).toBeNull();
		expect(decideNotification(request, view("private"), settings({ privateEnabled: false }), NOW, HIDDEN)).toBeNull();
	});

	it("hides the message when its preview is off", () => {
		expect(decideNotification(request, view("private"), settings({ privatePreview: false }), NOW, HIDDEN)?.body).toBe(HIDDEN);
		expect(decideNotification(request, view("group"), settings({ privatePreview: false }), NOW, HIDDEN)?.body).toBe(request.body);
	});

	it("never notifies for a muted chat, until the mute ends", () => {
		expect(decideNotification(request, view("group", MUTE_FOREVER), settings(), NOW, HIDDEN)).toBeNull();
		expect(decideNotification(request, view("group", NOW + 60), settings(), NOW, HIDDEN)).toBeNull();
		expect(decideNotification(request, view("group", NOW - 60), settings(), NOW, HIDDEN)).not.toBeNull();
	});

	it("asks the system for silence unless the sound is the default", () => {
		expect(decideNotification(request, view("group"), settings({ sound: "soft" }), NOW, HIDDEN)?.silent).toBe(true);
		expect(decideNotification(request, view("group"), settings({ sound: "off" }), NOW, HIDDEN)?.silent).toBe(true);
	});

	it("applies the strictest rules to a chat not in the list yet", () => {
		expect(decideNotification(request, undefined, settings(), NOW, HIDDEN)).toEqual({ ...request, silent: false });
		expect(decideNotification(request, undefined, settings({ channelsEnabled: false }), NOW, HIDDEN)).toBeNull();
		expect(decideNotification(request, undefined, settings({ groupsPreview: false }), NOW, HIDDEN)?.body).toBe(HIDDEN);
	});
});

describe("recalled message preview", () => {
	it("names a recalled message in previews and quotes", () => {
		const message = { action: null, recalled: true, text: "", mediaKind: null, fromId: 3 } as unknown as Parameters<typeof messagePreview>[0];
		expect(messagePreview(message, () => "Minh", copy, false)).toBe("Tin nhắn đã thu hồi");
	});
});
