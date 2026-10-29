// The account menu of the signed-in screens (@achoo254/app-shell AccountMenu):
// the avatar button heads the folder rail, the settings rail and the narrow
// chat list's top bar; the menu has the name and email, Chat's account pages,
// the hoandat.com account pages in a new tab and sign-out. It loads just
// after the first screen, the user's avatar standing in until then.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { UserSchema, UsersService } from "@achoo254/chat-proto/users";
import { toSelfUser } from "../src/api/adapters.ts";
import type { SelfUser } from "../src/api/adapters.ts";
import { AvatarStandIn, drawsChatAvatar } from "../src/messaging/ui/account-menu-slot.tsx";
import { renderApp, SELF } from "./render-app.tsx";

const LONG = { timeout: 8000 };
const PICTURE = "https://lh3.googleusercontent.com/a/thang";

function renderSignedIn(user: Record<string, unknown>, path = "/"): void {
	renderApp((router) => {
		router.service(UsersService, { getSelf: () => ({ user }) });
	}, path);
}

async function folderRail(): Promise<HTMLElement> {
	return screen.findByRole("navigation", { name: "Thư mục chat" }, LONG);
}

/** The menu and its avatar button (the <summary>, labelled with the name) in `scope`, once loaded. */
async function accountMenu(scope: HTMLElement): Promise<{ menu: HTMLDetailsElement; trigger: HTMLElement }> {
	const menu = await waitFor(() => {
		const found = scope.querySelector<HTMLDetailsElement>('details[data-id="account-menu"]');
		if (!found) throw new Error("no account menu yet");
		return found;
	}, LONG);
	const trigger = menu.querySelector<HTMLElement>("summary");
	if (!trigger) throw new Error("no account menu button");
	expect(trigger.getAttribute("aria-label")).toBe("Đức Thắng · Tài khoản");
	return { menu, trigger };
}

describe("account menu", () => {
	it("opens from the avatar at the top of the folder rail with the account's pages and sign-out", async () => {
		renderSignedIn(SELF);
		const rail = await folderRail();
		const { menu, trigger } = await accountMenu(rail);
		expect(rail.querySelectorAll('[data-id="account-menu"]')).toHaveLength(1);
		expect(rail.firstElementChild?.contains(menu)).toBe(true);

		await userEvent.click(trigger);
		expect(menu.open).toBe(true);
		expect(within(menu).getByText("thang@example.com")).toBeTruthy();
		const href = (dataId: string): string | null => menu.querySelector(`[data-id="${dataId}"]`)?.getAttribute("href") ?? null;
		expect(href("account-menu-profile")).toBe("/settings/profile");
		expect(href("account-menu-sessions")).toBe("/settings/sessions");
		expect(href("account-menu-settings")).toBe("/settings");
		expect(href("account-menu-idp-email")).toBe("https://auth.hoandat.com/account#account-email");
		expect(href("account-menu-idp-sign-in")).toBe("https://auth.hoandat.com/account#account-sign-in");

		// A Chat page opens in place and closes the menu.
		await userEvent.click(within(menu).getByRole("link", { name: "Phiên đăng nhập" }));
		expect(window.location.pathname).toBe("/settings/sessions");
		expect(menu.open).toBe(false);
	});

	it("closes on Escape and gives the focus back to its button", async () => {
		renderSignedIn(SELF);
		const { menu, trigger } = await accountMenu(await folderRail());
		await userEvent.click(trigger);
		expect(menu.open).toBe(true);
		await userEvent.keyboard("{Escape}");
		expect(menu.open).toBe(false);
		expect(document.activeElement).toBe(trigger);
	});

	it("signs out through the chat session's sign-out", async () => {
		renderSignedIn(SELF);
		const { menu, trigger } = await accountMenu(await folderRail());
		await userEvent.click(trigger);
		expect(window.localStorage.getItem("app:last-self")).not.toBeNull();
		await userEvent.click(within(menu).getByRole("button", { name: "Đăng xuất" }));
		// The local copy of the user goes first, as with Cài đặt › Đăng xuất.
		expect(window.localStorage.getItem("app:last-self")).toBeNull();
	});

	it("shows the IdP picture without a chat photo, and the chat photo over it otherwise", async () => {
		renderSignedIn({ ...SELF, idpPicture: PICTURE });
		const rail = await folderRail();
		await accountMenu(rail);
		const picture = rail.querySelector<HTMLImageElement>("summary img.shell-avatar");
		expect(picture?.getAttribute("src")).toBe(PICTURE);
		expect(picture?.getAttribute("referrerpolicy")).toBe("no-referrer");
		expect(rail.querySelector(".chat-account-photo")).toBeNull();

		expect(drawsChatAvatar({ idpPicture: PICTURE })).toBe(false);
		expect(drawsChatAvatar({ idpPicture: PICTURE, photoId: "f1" })).toBe(true);
		// No picture to show (or one the shared button would not load): Chat's initials.
		expect(drawsChatAvatar({})).toBe(true);
		expect(drawsChatAvatar({ idpPicture: "http://example.com/p.png" })).toBe(true);
	});

	it("heads the narrow chat list's top bar", async () => {
		renderSignedIn(SELF);
		await folderRail();
		const bar = document.querySelector<HTMLElement>("section.list header.n-head");
		if (!bar) throw new Error("no top bar");
		const { menu } = await accountMenu(bar);
		expect(bar.firstElementChild?.contains(menu)).toBe(true);
	});

	it("sits in the settings screens' rail", async () => {
		renderSignedIn(SELF, "/settings");
		await accountMenu(await screen.findByRole("navigation", { name: "Điều hướng" }, LONG));
	});

	it("shows the avatar in the button's place while the menu loads", () => {
		const self: SelfUser = { id: 42, username: "thang_dt", name: "Đức Thắng", bio: "", email: "", isOperator: false };
		const { container, rerender } = render(<AvatarStandIn self={{ ...self, idpPicture: PICTURE }} />);
		const picture = container.querySelector(".chat-account-stand-in img.avatar-photo");
		expect(picture?.getAttribute("src")).toBe(PICTURE);
		expect(picture?.getAttribute("referrerpolicy")).toBe("no-referrer");
		rerender(<AvatarStandIn self={self} />);
		const avatar = container.querySelector(".chat-account-stand-in .avatar");
		expect(avatar?.textContent).not.toBe("");
		expect(avatar?.querySelector("img")).toBeNull();
	});

	it("carries the IdP picture of the self user", () => {
		const user = create(UserSchema, { id: 42n, name: "Đức Thắng", idpPicture: PICTURE });
		expect(toSelfUser(user).idpPicture).toBe(PICTURE);
		expect(toSelfUser(create(UserSchema, { id: 42n })).idpPicture).toBeUndefined();
	});
});
