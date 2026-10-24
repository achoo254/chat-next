import { ClientPlatform, AuthService, type RevokeSessionRequest } from "@achoo254/chat-proto/auth";
import { UsersService } from "@achoo254/chat-proto/users";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderApp, SELF } from "./render-app.tsx";

const SESSIONS = [
	{ id: 1n, platform: ClientPlatform.WEB, deviceName: "Chrome trên macOS", location: "Hà Nội", current: true },
	{ id: 2n, platform: ClientPlatform.IOS, deviceName: "iPhone 15", location: "TP. Hồ Chí Minh", lastActiveAt: 1_760_000_000n },
	{ id: 3n, platform: ClientPlatform.WEB, deviceName: "Windows 11", location: "Hà Nội", lastActiveAt: 1_759_000_000n },
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
		// Older than yesterday: the full date, after the place.
		const lastActive = new Date(1_759_000_000 * 1000);
		const full = [lastActive.getDate(), lastActive.getMonth() + 1].map((n) => String(n).padStart(2, "0")).join("/") + `/${lastActive.getFullYear()}`;
		expect(within(others).getByText(`Hà Nội · ${full}`)).toBeTruthy();

		await userEvent.click(within(others).getByRole("button", { name: "Đăng xuất: iPhone 15" }));

		expect(await screen.findByText("Đã đăng xuất iPhone 15")).toBeTruthy();
		expect(revoked.map((req) => req.sessionId)).toEqual([2n]);
		expect(within(others).getAllByRole("listitem")).toHaveLength(1);
		expect(within(others).queryByText("iPhone 15")).toBeNull();
		expect(within(others).getByText("Windows 11")).toBeTruthy();
	});

	it("shows today's activity as a relative time and the new sign-in badge from the server", async () => {
		const now = Math.floor(Date.now() / 1000);
		const startOfToday = Math.floor(new Date(new Date().setHours(0, 0, 0, 0)).getTime() / 1000);
		const today = Math.max(startOfToday, now - 60);
		const clock = new Intl.DateTimeFormat("vi", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(today * 1000);
		renderApp((router) => {
			router.service(UsersService, { getSelf: () => ({ user: SELF }) });
			router.service(AuthService, {
				listSessions: () => ({
					sessions: [
						{ id: 1n, platform: ClientPlatform.WEB, deviceName: "Edge trên macOS", current: true },
						{ id: 4n, platform: ClientPlatform.WEB, deviceName: "Firefox trên Windows", lastActiveAt: BigInt(today), newLogin: true },
					],
				}),
			});
		}, "/settings/sessions");

		const others = await screen.findByRole("region", { name: "Thiết bị khác" });
		expect(within(others).getByText(`Hôm nay ${clock}`)).toBeTruthy();
		expect(within(others).getByText("Mới đăng nhập")).toBeTruthy();
		const current = screen.getByRole("region", { name: "Phiên này" });
		expect(within(current).queryByText("Mới đăng nhập")).toBeNull();
		expect(within(current).getByText("Đang hoạt động")).toBeTruthy();
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
