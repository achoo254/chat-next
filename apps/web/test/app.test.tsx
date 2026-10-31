import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { UsersService } from "@achoo254/chat-proto/users";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import brandConfig from "../../../brand.config.json";
import { CORE_LAST_USER_KEY } from "../src/api/offline-self.ts";
import { renderApp, SELF } from "./render-app.tsx";

// The shared header's guest button: "Đăng ký miễn phí", with the short "Đăng ký" for phones beside it (CSS picks one).
const SIGN_UP = /^Đăng ký miễn phí/;

/** A server whose GetSelf answers signed out. */
function signedOutRoutes(router: ConnectRouter): void {
	router.service(UsersService, {
		getSelf: () => {
			throw new ConnectError("no session", Code.Unauthenticated);
		},
	});
}

describe("boot", () => {
	it("shows the welcome page of the shared shell with one call to sign in", async () => {
		renderApp(signedOutRoutes);

		expect(await screen.findByRole("heading", { level: 1, name: "Nhắn tin nhanh trên mọi thiết bị" })).toBeTruthy();
		expect(screen.getByRole("heading", { level: 2, name: `Đăng nhập vào ${brandConfig.appName}` })).toBeTruthy();
		expect(screen.getByRole("heading", { level: 3, name: "Tìm lại tin cũ" })).toBeTruthy();
		// The shared top bar: the app name goes home, "Đăng ký miễn phí" opens /login.
		expect(screen.getByRole("link", { name: brandConfig.appName }).getAttribute("href")).toBe("/");
		expect(screen.getByRole("link", { name: SIGN_UP }).getAttribute("href")).toBe("/login");
		// One call to action; the account page creates accounts.
		const signIn = screen.getByRole("link", { name: "Đăng nhập bằng hoandat.com" });
		expect(signIn.getAttribute("href")).toBe("/auth/login?locale=vi");
		expect(document.querySelectorAll('a[href^="/auth/login"]')).toHaveLength(1);
		expect(screen.queryByRole("link", { name: /Tạo tài khoản/ })).toBeNull();

		await userEvent.click(screen.getByRole("button", { name: "English" }));

		// English copy loads on first use, so the switch lands a moment later.
		expect((await screen.findByRole("link", { name: "Sign in with hoandat.com" })).getAttribute("href")).toBe("/auth/login?locale=en");
		expect(screen.getByRole("heading", { level: 1, name: "Fast messaging on every device" })).toBeTruthy();
		await waitFor(() => expect(document.documentElement.lang).toBe("en"));
		// The shared choice of every hoandat.com app.
		expect(document.cookie).toContain("hd_lang=en");
	});

	it("offers Vietnamese, English and Chinese, and shows the whole welcome page in Chinese", async () => {
		renderApp(signedOutRoutes);
		const group = await screen.findByRole("group", { name: "Ngôn ngữ" });
		expect(within(group).getAllByRole("button").map((button) => button.textContent)).toEqual(["Tiếng Việt", "English", "中文"]);

		await userEvent.click(within(group).getByRole("button", { name: "中文" }));

		expect((await screen.findByRole("link", { name: "使用 hoandat.com 登录" })).getAttribute("href")).toBe("/auth/login?locale=zh-cn");
		expect(screen.getByRole("heading", { level: 1, name: "在所有设备上快速聊天" })).toBeTruthy();
		expect(screen.getByRole("heading", { level: 3, name: "找回旧消息" })).toBeTruthy();
		await waitFor(() => expect(document.documentElement.lang).toBe("zh-CN"));
		expect(document.cookie).toContain("hd_lang=zh-CN");
	});

	it("opens the sign-in card alone on /login, in place from the top bar", async () => {
		renderApp(signedOutRoutes);
		await userEvent.click(await screen.findByRole("link", { name: SIGN_UP }));

		expect(await screen.findByRole("heading", { level: 1, name: `Đăng nhập vào ${brandConfig.appName}` })).toBeTruthy();
		expect(window.location.pathname).toBe("/login");
		expect(screen.getByRole("link", { name: SIGN_UP }).getAttribute("aria-current")).toBe("page");
		expect(screen.getByRole("link", { name: "Đăng nhập bằng hoandat.com" }).getAttribute("href")).toBe("/auth/login?locale=vi");
		expect(screen.queryByRole("heading", { level: 1, name: "Nhắn tin nhanh trên mọi thiết bị" })).toBeNull();
	});

	it("opens the chats on /login when already signed in", async () => {
		renderApp((router) => {
			router.service(UsersService, { getSelf: () => ({ user: SELF }) });
		}, "/login");
		expect(await screen.findByText("Chưa có chat nào ở đây", {}, { timeout: 5000 })).toBeTruthy();
		expect(window.location.pathname).toBe("/");
	});

	it("keeps the language picked in Chat before the shared choice, follows a stored Chinese choice, and ignores one Chat does not have", async () => {
		window.localStorage.setItem("locale", "en");
		renderApp(signedOutRoutes);
		expect(await screen.findByRole("link", { name: "Sign in with hoandat.com" })).toBeTruthy();
		cleanup();

		// Chinese, picked in any hoandat.com app: Chat has it too.
		document.cookie = "hd_lang=zh-CN; Path=/";
		window.localStorage.removeItem("locale");
		renderApp(signedOutRoutes);
		expect(await screen.findByRole("link", { name: "使用 hoandat.com 登录" })).toBeTruthy();
		await waitFor(() => expect(document.documentElement.lang).toBe("zh-CN"));
		cleanup();

		// A language no Chat build has counts as no choice: Vietnamese.
		document.cookie = "hd_lang=fr; Path=/";
		renderApp(signedOutRoutes);
		expect(await screen.findByRole("link", { name: "Đăng nhập bằng hoandat.com" })).toBeTruthy();
	});

	it("follows a language picked in another app when the page comes back into view", async () => {
		renderApp(signedOutRoutes);
		expect(await screen.findByRole("link", { name: "Đăng nhập bằng hoandat.com" })).toBeTruthy();

		document.cookie = "hd_lang=en; Path=/";
		window.dispatchEvent(new Event("focus"));

		expect(await screen.findByRole("link", { name: "Sign in with hoandat.com" })).toBeTruthy();
	});

	it("asks sign-in to come back to an invite link opened while signed out", async () => {
		const token = "V-puXq3hT9mZ2cLk8RbkVUp";
		renderApp(signedOutRoutes, `/join/${token}`);
		// The server keeps return_to across the IdP round trip, even when it ends in another tab.
		const signIn = await screen.findByRole("link", { name: "Đăng nhập bằng hoandat.com" });
		expect(signIn.getAttribute("href")).toBe(`/auth/login?locale=vi&return_to=%2Fjoin%2F${token}`);
	});

	it("keeps the invite link when the header's sign-in is used on it", async () => {
		const token = "V-puXq3hT9mZ2cLk8RbkVUp";
		renderApp(signedOutRoutes, `/join/${token}`);
		const header = await screen.findByRole("banner");
		const signIn = within(header).getByRole("link", { name: SIGN_UP });
		expect(signIn.getAttribute("href")).toBe(`/auth/login?locale=vi&return_to=%2Fjoin%2F${token}`);
	});

	it("leads the header's sign-in to /login on the welcome page", async () => {
		renderApp(signedOutRoutes, "/");
		const header = await screen.findByRole("banner");
		expect(within(header).getByRole("link", { name: SIGN_UP }).getAttribute("href")).toBe("/login");
	});

	it("opens the chat list when signed in", async () => {
		renderApp((router) => {
			router.service(UsersService, { getSelf: () => ({ user: SELF }) });
		});

		// Signed in, the app opens the (empty) chat list.
		expect(await screen.findByText("Chưa có chat nào ở đây", {}, { timeout: 5000 })).toBeTruthy();
		expect(screen.getAllByText("ĐT").length).toBeGreaterThan(0);
		// The empty state says "bấm +": the new-chat button must be there.
		expect(screen.getAllByRole("button", { name: "Tạo chat mới" }).length).toBeGreaterThan(0);
		expect(screen.queryByText(/Sửa thư mục/)).toBeNull();
	});

	it("offers a retry when the server cannot be reached", async () => {
		let calls = 0;
		renderApp((router) => {
			router.service(UsersService, {
				getSelf: () => {
					calls += 1;
					if (calls === 1) throw new ConnectError("fetch failed", Code.Unavailable);
					return { user: SELF };
				},
			});
		});

		await userEvent.click(await screen.findByRole("button", { name: "Thử lại" }));

		expect(await screen.findByText("Chưa có chat nào ở đây", {}, { timeout: 5000 })).toBeTruthy();
		expect(calls).toBe(2);
	});

	it("opens the chats on this device when the server cannot be reached", async () => {
		window.localStorage.setItem(CORE_LAST_USER_KEY, "42");
		window.localStorage.setItem("app:last-self", JSON.stringify({ id: 42, name: "Đức Thắng", username: "thang_dt", bio: "", email: "", isOperator: false }));
		try {
			renderApp((router) => {
				router.service(UsersService, {
					getSelf: () => {
						throw new ConnectError("fetch failed", Code.Unavailable);
					},
				});
			});
			expect(await screen.findByText("Chưa có chat nào ở đây", {}, { timeout: 5000 })).toBeTruthy();
			expect(screen.queryByRole("button", { name: "Thử lại" })).toBeNull();
		} finally {
			window.localStorage.removeItem(CORE_LAST_USER_KEY);
			window.localStorage.removeItem("app:last-self");
		}
	});

	it("forgets the remembered user when the server says the session is gone", async () => {
		window.localStorage.setItem(CORE_LAST_USER_KEY, "42");
		window.localStorage.setItem("app:last-self", JSON.stringify({ id: 42, name: "Đức Thắng", username: "thang_dt", bio: "", email: "", isOperator: false }));
		renderApp((router) => {
			router.service(UsersService, {
				getSelf: () => {
					throw new ConnectError("no session", Code.Unauthenticated);
				},
			});
		});
		expect(await screen.findByRole("link", { name: "Đăng nhập bằng hoandat.com" })).toBeTruthy();
		expect(window.localStorage.getItem("app:last-self")).toBeNull();
		window.localStorage.removeItem(CORE_LAST_USER_KEY);
	});

	it("opens settings from the rail without a page load", async () => {
		renderApp((router) => {
			router.service(UsersService, { getSelf: () => ({ user: SELF }) });
		});

		const links = await screen.findAllByRole("link", { name: "Cài đặt" }, { timeout: 5000 });
		await userEvent.click(links[0] as HTMLElement);

		expect(window.location.pathname).toBe("/settings");
		expect(await screen.findByRole("heading", { level: 1, name: "Hồ sơ" })).toBeTruthy();
	});
});
