import { Code, ConnectError } from "@connectrpc/connect";
import { UsersService } from "@app/proto-ts/users";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import brandConfig from "../../../brand.config.json";
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

		expect(screen.getByRole("link", { name: "Sign in with your hoandat account" }).getAttribute("href")).toBe(
			"/auth/login?locale=en",
		);
		expect(screen.getByRole("link", { name: "Create account" }).getAttribute("href")).toBe(
			"/auth/login?prompt=create&locale=en",
		);
		expect(document.documentElement.lang).toBe("en");
		expect(window.localStorage.getItem("locale")).toBe("en");
	});

	it("shows the shell with the user's name when signed in", async () => {
		renderApp((router) => {
			router.service(UsersService, { getSelf: () => ({ user: SELF }) });
		});

		expect(await screen.findByRole("heading", { name: "Xin chào, Đức Thắng" })).toBeTruthy();
		expect(screen.getByText("ĐT")).toBeTruthy();
		expect(screen.getByRole("heading", { name: "Chưa có cuộc trò chuyện" })).toBeTruthy();
		const search = screen.getByRole("searchbox", { name: "Tìm trò chuyện và tin nhắn" });
		expect((search as HTMLInputElement).disabled).toBe(true);
		expect(screen.getByRole("link", { name: "Trò chuyện" }).getAttribute("aria-current")).toBe("page");
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

		expect(await screen.findByRole("heading", { name: "Xin chào, Đức Thắng" })).toBeTruthy();
		expect(calls).toBe(2);
	});

	it("opens settings from the rail without a page load", async () => {
		renderApp((router) => {
			router.service(UsersService, { getSelf: () => ({ user: SELF }) });
		});

		await userEvent.click(await screen.findByRole("link", { name: "Cài đặt" }));

		expect(window.location.pathname).toBe("/settings/profile");
		expect(await screen.findByRole("heading", { level: 1, name: "Hồ sơ" })).toBeTruthy();
	});
});
