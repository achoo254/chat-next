// Public pages (/privacy, /terms, /delete-account): open without signing in,
// linked from the welcome screen and Settings.
import { Code, ConnectError } from "@connectrpc/connect";
import { UsersService } from "@app/proto-ts/users";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { deletionTicks, DELETION_GRACE_DAYS } from "../src/i18n/account-deletion.ts";
import { matchLegal, matchRoute, returnPathFor } from "../src/router.tsx";
import { renderApp, SELF } from "./render-app.tsx";

/** A server whose GetSelf answers signed out, counting the calls. */
function signedOut(): { calls: () => number; routes: Parameters<typeof renderApp>[0] } {
	let calls = 0;
	return {
		calls: () => calls,
		routes: (router) => {
			router.service(UsersService, {
				getSelf: () => {
					calls += 1;
					throw new ConnectError("no session", Code.Unauthenticated);
				},
			});
		},
	};
}

describe("legal routes", () => {
	it("matches the three public pages only", () => {
		expect(matchLegal("/privacy")).toBe("privacy");
		expect(matchLegal("/privacy/")).toBe("privacy");
		expect(matchLegal("/terms")).toBe("terms");
		expect(matchLegal("/delete-account")).toBe("delete-account");
		expect(matchLegal("/")).toBeNull();
		expect(matchLegal("/privacy/more")).toBeNull();
		expect(matchLegal("/settings/privacy")).toBeNull();
		// Not fooled by the prototype of the lookup table.
		expect(matchLegal("/constructor")).toBeNull();
	});

	it("stays out of the signed-in routes and of sign-in's return_to", () => {
		expect(matchRoute("/privacy")).toBeNull();
		expect(returnPathFor("/terms")).toBeUndefined();
	});
});

describe("public pages", () => {
	it("shows the privacy policy without asking the server who is signed in", async () => {
		const server = signedOut();
		renderApp(server.routes, "/privacy");

		expect(await screen.findByRole("heading", { level: 1, name: "Chính sách quyền riêng tư" })).toBeTruthy();
		expect(screen.getByRole("heading", { level: 2, name: "Giữ bao lâu" })).toBeTruthy();
		const nav = screen.getByRole("navigation", { name: "Chính sách" });
		expect(within(nav).getByRole("link", { name: "Chính sách quyền riêng tư" }).getAttribute("aria-current")).toBe("page");
		expect(server.calls()).toBe(0);
		expect(document.title).toContain("Chính sách quyền riêng tư");
	});

	it("moves between the pages and switches to English", async () => {
		renderApp(signedOut().routes, "/terms");
		expect(await screen.findByRole("heading", { level: 1, name: "Điều khoản sử dụng" })).toBeTruthy();

		await userEvent.click(within(screen.getByRole("navigation", { name: "Chính sách" })).getByRole("link", { name: "Xoá tài khoản" }));
		expect(await screen.findByRole("heading", { level: 1, name: "Xoá tài khoản" })).toBeTruthy();
		expect(window.location.pathname).toBe("/delete-account");

		await userEvent.click(screen.getByRole("button", { name: "English" }));
		expect(await screen.findByRole("heading", { level: 1, name: "Delete your account" })).toBeTruthy();
		await waitFor(() => expect(document.documentElement.lang).toBe("en"));
	});

	it("explains account deletion with the same lines as Settings › Tài khoản", async () => {
		renderApp(signedOut().routes, "/delete-account");
		expect(await screen.findByRole("heading", { level: 1, name: "Xoá tài khoản" })).toBeTruthy();

		const steps = screen.getAllByRole("listitem").map((item) => item.textContent);
		expect(steps).toContain("Mở Cài đặt › Tài khoản, đến mục Xoá tài khoản chat.");
		for (const line of deletionTicks.vi(DELETION_GRACE_DAYS, "auth.hoandat.com")) expect(steps).toContain(line);
		const idp = screen.getByRole("link", { name: /Tài khoản hoandat\.com/ });
		expect(idp.getAttribute("href")).toBe("https://auth.hoandat.com/account");
		expect(idp.getAttribute("target")).toBe("_blank");
	});

	it("opens for a signed-in user too, and the app link goes home", async () => {
		renderApp((router) => {
			router.service(UsersService, { getSelf: () => ({ user: SELF }) });
		}, "/privacy");
		expect(await screen.findByRole("heading", { level: 1, name: "Chính sách quyền riêng tư" })).toBeTruthy();
		expect(screen.getByRole("link", { name: "Chat" }).getAttribute("href")).toBe("/");
	});
});

describe("links to the public pages", () => {
	it("are on the welcome screen and open in place", async () => {
		renderApp(signedOut().routes);
		const nav = await screen.findByRole("navigation", { name: "Chính sách" });
		expect(within(nav).getByRole("link", { name: "Điều khoản sử dụng" }).getAttribute("href")).toBe("/terms");
		expect(within(nav).getByRole("link", { name: "Xoá tài khoản" }).getAttribute("href")).toBe("/delete-account");

		await userEvent.click(within(nav).getByRole("link", { name: "Chính sách quyền riêng tư" }));
		expect(await screen.findByRole("heading", { level: 1, name: "Chính sách quyền riêng tư" })).toBeTruthy();
		expect(window.location.pathname).toBe("/privacy");
	});

	it("are in Settings and open in a new tab", async () => {
		renderApp((router) => {
			router.service(UsersService, { getSelf: () => ({ user: SELF }) });
		}, "/settings/profile");
		const nav = await screen.findByRole("navigation", { name: "Danh mục cài đặt" });
		const privacy = within(nav).getByRole("link", { name: /Chính sách quyền riêng tư/ });
		expect(privacy.getAttribute("href")).toBe("/privacy");
		expect(privacy.getAttribute("target")).toBe("_blank");
		expect(within(nav).getByRole("link", { name: /Điều khoản sử dụng/ }).getAttribute("href")).toBe("/terms");
	});
});
