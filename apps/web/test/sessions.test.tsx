import { ClientPlatform, AuthService, type RevokeSessionRequest } from "@app/proto-ts/auth";
import { UsersService } from "@app/proto-ts/users";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderApp, SELF } from "./render-app.tsx";

const SESSIONS = [
	{ id: 1n, platform: ClientPlatform.WEB, deviceName: "Chrome trên macOS", location: "Hà Nội", current: true },
	{ id: 2n, platform: ClientPlatform.IOS, deviceName: "iPhone 15", location: "TP. Hồ Chí Minh", lastActiveAt: 1_760_000_000n },
	{ id: 3n, platform: ClientPlatform.DESKTOP, deviceName: "Windows 11", location: "Hà Nội", lastActiveAt: 1_759_000_000n },
];

describe("sessions settings", () => {
	it("marks the current session and removes a revoked one", async () => {
		const revoked: RevokeSessionRequest[] = [];
		renderApp((router) => {
			router.service(UsersService, { getSelf: () => ({ user: SELF }) });
			router.service(AuthService, {
				listSessions: () => ({ sessions: SESSIONS }),
				revokeSession: (req) => {
					revoked.push(req);
					return {};
				},
			});
		}, "/settings/sessions");

		const currentCard = await screen.findByRole("region", { name: "Phiên này" });
		expect(within(currentCard).getByText("Chrome trên macOS")).toBeTruthy();
		expect(within(currentCard).getByText("Phiên này", { selector: ".current" })).toBeTruthy();
		// The current session signs out through the HTTP route, not RevokeSession.
		expect(within(currentCard).getByRole("button", { name: "Đăng xuất" }).closest("form")?.getAttribute("action")).toBe(
			"/auth/logout",
		);

		const others = screen.getByRole("region", { name: "Thiết bị khác" });
		expect(within(others).getAllByRole("listitem")).toHaveLength(2);

		await userEvent.click(within(others).getByRole("button", { name: "Đăng xuất: iPhone 15" }));

		expect(await screen.findByText("Đã đăng xuất iPhone 15")).toBeTruthy();
		expect(revoked.map((req) => req.sessionId)).toEqual([2n]);
		expect(within(others).getAllByRole("listitem")).toHaveLength(1);
		expect(within(others).queryByText("iPhone 15")).toBeNull();
		expect(within(others).getByText("Windows 11")).toBeTruthy();
	});

	it("signs out every other session", async () => {
		renderApp((router) => {
			router.service(UsersService, { getSelf: () => ({ user: SELF }) });
			router.service(AuthService, {
				listSessions: () => ({ sessions: SESSIONS }),
				revokeOtherSessions: () => ({ revokedCount: 2 }),
			});
		}, "/settings/sessions");

		await userEvent.click(await screen.findByRole("button", { name: "Đăng xuất 2 phiên" }));

		expect(await screen.findByText("Đã đăng xuất 2 phiên khác")).toBeTruthy();
		expect(screen.getByText("Không có phiên nào khác.")).toBeTruthy();
	});
});
