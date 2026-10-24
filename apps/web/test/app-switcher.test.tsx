// The app switcher (@shared-next/app-switcher) of the signed-in screens: the
// other apps of the domain, Chat itself left out, every link tagged as coming
// from Chat. In the folder rail of the chat screens and the rail of the
// other screens, before Cài đặt.
import { Code, ConnectError } from "@connectrpc/connect";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { UsersService } from "@achoo254/chat-proto/users";
import { renderApp, SELF } from "./render-app.tsx";

const LONG = { timeout: 8000 };
const UTM = "utm_source=chat&utm_medium=app_switcher";
const SWITCH = { name: "Chuyển ứng dụng" };

function renderSignedIn(path: string): void {
	renderApp((router) => {
		router.service(UsersService, { getSelf: () => ({ user: SELF }) });
	}, path);
}

function expectBeforeSettings(rail: HTMLElement): HTMLElement {
	const button = within(rail).getByRole("button", SWITCH);
	const settings = within(rail).getByRole("link", { name: "Cài đặt" });
	expect(button.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	return button;
}

describe("app switcher", () => {
	it("lists the other apps of the domain from the folder rail; Esc closes it", async () => {
		renderSignedIn("/");
		const rail = await screen.findByRole("navigation", { name: "Thư mục chat" }, LONG);
		const button = expectBeforeSettings(rail);

		await userEvent.click(button);
		const panel = within(rail).getByRole("dialog", { name: "Ứng dụng" });
		expect(within(panel).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
			`https://scribe.hoandat.com/?${UTM}`,
			`https://localman.hoandat.com/?${UTM}`,
			`https://tunnel.hoandat.com/?${UTM}`,
			`https://auth.hoandat.com/account?${UTM}`,
		]);

		await userEvent.keyboard("{Escape}");
		expect(within(rail).queryByRole("dialog")).toBeNull();
		expect(document.activeElement).toBe(button);
	});

	it("sits in the rail of the settings screens", async () => {
		renderSignedIn("/settings");
		expectBeforeSettings(await screen.findByRole("navigation", { name: "Điều hướng" }, LONG));
	});

	it("is not shown signed out", async () => {
		renderApp((router) => {
			router.service(UsersService, {
				getSelf: () => {
					throw new ConnectError("no session", Code.Unauthenticated);
				},
			});
		});
		expect(await screen.findByRole("link", { name: "Tạo tài khoản" }, LONG)).toBeTruthy();
		expect(screen.queryByRole("button", SWITCH)).toBeNull();
	});
});
