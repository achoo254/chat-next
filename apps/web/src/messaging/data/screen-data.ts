// The data a screen needs before it shows, as resources (components/preload.ts):
// the route starts them along with the screen's code (messaging-root.tsx,
// chat-screen.tsx) and the screen reads the same request.
import { resource, type Resource } from "../../components/preload.ts";
import type { Bots, OwnBot } from "../bots/api.ts";
import type { Hook, HookNames, Integrations } from "../integrations/api.ts";
import type { Transport } from "@connectrpc/connect";
import { loadPrivacyClient, type AccountData } from "../settings/privacy-api.ts";
import type { BlockedPerson, Page, Privacy, Remote } from "./remote.ts";
import type { ChatStore } from "./store.ts";

/**
 * The caller's bots, for the console list (`page` 0) or one bot's page: each
 * page loads its own, so coming back to the list after a change shows it.
 */
export function myBotsData(bots: Bots, page: number): Resource<OwnBot[]> {
	return resource(bots, `mine:${page}`, () => bots.mine());
}

export function privacyData(remote: Remote): Resource<Privacy> {
	return resource(remote, "privacy", () => remote.privacy());
}

/** The first page of blocked people. */
export function blockedData(remote: Remote): Resource<Page<BlockedPerson>> {
	return resource(remote, "blocked", () => remote.blockedUsers());
}

/** The synced notification settings, kept by the store. */
export function notificationSettingsData(store: ChatStore): Resource<unknown> {
	return resource(store, "notification-settings", () => store.loadNotificationSettings());
}

/** A chat's webhooks. */
export function hooksData(integrations: Integrations, chatId: number): Resource<{ hooks: Hook[]; names: HookNames }> {
	return resource(integrations, `hooks:${chatId}`, () => integrations.hooks(chatId));
}

/** One webhook. */
export function hookData(integrations: Integrations, hookId: string): Resource<{ hook: Hook; names: HookNames }> {
	return resource(integrations, `hook:${hookId}`, () => integrations.hook(hookId));
}

/** The "Tài khoản" tab: the latest export and what deleting the account involves. */
export function accountData(transport: Transport): Resource<AccountData> {
	return resource(transport, "account", () => loadPrivacyClient().then((module) => module.privacyClient(transport).account()));
}
