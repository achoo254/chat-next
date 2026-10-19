import { Code, ConnectError } from "@connectrpc/connect";
import { UsersService } from "@app/proto-ts/users";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import brandConfig from "../../../brand.config.json";
import { CORE_LAST_USER_KEY } from "../src/api/offline-self.ts";
import { renderApp, SELF } from "./render-app.tsx";

describe("boot", () => {
	it("shows the welcome screen with IdP links when signed out", async () => {
		renderApp((router) => {
			router.service(UsersService, {
				getSelf: () => {
					throw new ConnectError("no session", Code.Unauthenticated);
				},
			});
		});

		expect(await screen.findByRole("heading", { level: 1, name: brandConfig.appName })).toBeTruthy();
		expect(screen.getByText(brandConfig.description)).toBeTruthy();
		const signIn = screen.getByRole("link", { name: "Đăng nhập bằng tài khoản hoandat" });
		const create = screen.getByRole("link", { name: "Tạo tài khoản" });
		expect(signIn.getAttribute("href")).toBe("/auth/login?locale=vi");
		expect(create.getAttribute("href")).toBe("/auth/login?prompt=create&locale=vi");
		expect(screen.getAllByText(/auth\.hoandat\.com/).length).toBeGreaterThan(0);

		await userEvent.click(screen.getByRole("button", { name: "English" }));

		// English copy loads on first use, so the switch lands a moment later.
		expect((await screen.findByRole("link", { name: "Sign in with your hoandat account" })).getAttribute("href")).toBe(
			"/auth/login?locale=en",
		);
		expect(screen.getByRole("link", { name: "Create account" }).getAttribute("href")).toBe(
			"/auth/login?prompt=create&locale=en",
		);
		await waitFor(() => expect(document.documentElement.lang).toBe("en"));
		expect(window.localStorage.getItem("locale")).toBe("en");
	});

	it("asks sign-in to come back to an invite link opened while signed out", async () => {
		const token = "V-puXq3hT9mZ2cLk8RbkVUp";
		renderApp((router) => {
			router.service(UsersService, {
				getSelf: () => {
					throw new ConnectError("no session", Code.Unauthenticated);
				},
			});
		}, `/join/${token}`);
		// The server keeps return_to across the IdP round trip, even when it ends in another tab.
		const signIn = await screen.findByRole("link", { name: "Đăng nhập bằng tài khoản hoandat" });
		expect(signIn.getAttribute("href")).toBe(`/auth/login?locale=vi&return_to=%2Fjoin%2F${token}`);
		expect(screen.getByRole("link", { name: "Tạo tài khoản" }).getAttribute("href")).toBe(`/auth/login?prompt=create&locale=vi&return_to=%2Fjoin%2F${token}`);
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
		expect(await screen.findByRole("link", { name: "Đăng nhập bằng tài khoản hoandat" })).toBeTruthy();
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
