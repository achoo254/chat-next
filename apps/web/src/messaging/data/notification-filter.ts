// Applies the user's notification settings to a notification the core asks
// for (settings.html#notifications): per chat type on or off, the message
// shown or hidden, the sound, and per-chat mutes. On a device that gets Web
// Push, a message arriving while no window of the app is visible is left to
// the push (the server sends it exactly then), so it is not shown twice. Pure, so it is unit-tested
// directly; the web client calls it on the main thread before showing one.
import { isMuted, type DialogView, type NotificationSettings } from "@app/core";

export interface NotificationInput {
	readonly title: string;
	readonly body: string;
	readonly tag: string;
	readonly chatId: number;
	/** No window of the app was visible (NotificationRequest.background). */
	readonly background?: boolean;
}

export interface NotificationDecision extends NotificationInput {
	/** The system plays no sound (sound "Nhẹ" plays the app's own soft tone, "Tắt" none). */
	readonly silent: boolean;
}

type ChatGroup = "private" | "groups" | "channels";

function groupOf(view: DialogView): ChatGroup {
	switch (view.chat?.type) {
		case "group":
			return "groups";
		case "channel":
			return "channels";
		default:
			return "private";
	}
}

function allowed(settings: NotificationSettings, group: ChatGroup): { enabled: boolean; preview: boolean } {
	switch (group) {
		case "private":
			return { enabled: settings.privateEnabled, preview: settings.privatePreview };
		case "groups":
			return { enabled: settings.groupsEnabled, preview: settings.groupsPreview };
		case "channels":
			return { enabled: settings.channelsEnabled, preview: settings.channelsPreview };
	}
}

/**
 * What to show for `request`, or null for nothing. A chat not in the list
 * yet gets the strictest of the three chat types. `hiddenBody` replaces the
 * message when its preview is off. `pushOnDevice`: this device gets Web Push.
 */
export function decideNotification(
	request: NotificationInput,
	view: DialogView | undefined,
	settings: NotificationSettings,
	nowSeconds: number,
	hiddenBody: string,
	pushOnDevice = false,
): NotificationDecision | null {
	if (pushOnDevice && request.background === true) return null;
	let rule: { enabled: boolean; preview: boolean };
	if (view === undefined) {
		const all = (["private", "groups", "channels"] as const).map((group) => allowed(settings, group));
		rule = { enabled: all.every((item) => item.enabled), preview: all.every((item) => item.preview) };
	} else {
		if (isMuted(view.dialog, nowSeconds)) return null;
		rule = allowed(settings, groupOf(view));
	}
	if (!rule.enabled) return null;
	return {
		title: request.title,
		body: rule.preview ? request.body : hiddenBody,
		tag: request.tag,
		chatId: request.chatId,
		silent: settings.sound !== "default",
	};
}
