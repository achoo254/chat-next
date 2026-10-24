import { Code, ConnectError } from "@connectrpc/connect";
import type { UpdateProfileRequest } from "@achoo254/chat-proto/users";
import { UsersService } from "@achoo254/chat-proto/users";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderApp, SELF } from "./render-app.tsx";

describe("profile settings", () => {
	it("saves a new display name", async () => {
		const updates: UpdateProfileRequest[] = [];
		renderApp((router) => {
			router.service(UsersService, {
				getSelf: () => ({ user: SELF }),
				updateProfile: (req) => {
					updates.push(req);
					return { user: { ...SELF, name: req.name ?? SELF.name, bio: req.bio ?? SELF.bio } };
				},
			});
		}, "/settings/profile");

		const name = await screen.findByLabelText("Tên hiển thị");
		await userEvent.clear(name);
		await userEvent.type(name, "Thắng Đức");
		await userEvent.click(screen.getByRole("button", { name: "Lưu thay đổi" }));

		expect(await screen.findByText("Đã lưu hồ sơ")).toBeTruthy();
		expect(updates).toHaveLength(1);
		expect(updates[0]?.name).toBe("Thắng Đức");
		expect(updates[0]?.bio).toBeUndefined();
		// The rail avatar follows the saved name.
		expect(screen.getAllByText("TĐ").length).toBeGreaterThan(0);
	});

	it("validates the username before calling the server", async () => {
		let calls = 0;
		renderApp((router) => {
			router.service(UsersService, {
				getSelf: () => ({ user: SELF }),
				setUsername: () => {
					calls += 1;
					return { user: SELF };
				},
			});
		}, "/settings/profile");

		const username = await screen.findByLabelText("Username");
		await userEvent.clear(username);
		await userEvent.type(username, "Thang-DT");

		expect(screen.getByText("Chỉ dùng chữ a–z, số và dấu gạch dưới")).toBeTruthy();
		expect(username.getAttribute("aria-invalid")).toBe("true");
		expect((screen.getByRole("button", { name: "Lưu thay đổi" }) as HTMLButtonElement).disabled).toBe(true);

		await userEvent.clear(username);
		await userEvent.type(username, "ab");
		expect(screen.getByText("Cần từ 3 đến 32 ký tự")).toBeTruthy();
		expect(calls).toBe(0);
	});

	it("shows the conflict inline when the username is taken", async () => {
		renderApp((router) => {
			router.service(UsersService, {
				getSelf: () => ({ user: SELF }),
				setUsername: () => {
					throw new ConnectError("username taken", Code.AlreadyExists);
				},
			});
		}, "/settings/profile");

		const username = await screen.findByLabelText("Username");
		await userEvent.clear(username);
		await userEvent.type(username, "minh");
		await userEvent.click(screen.getByRole("button", { name: "Lưu thay đổi" }));

		expect(await screen.findByText("@minh đã có người dùng")).toBeTruthy();
		expect(username.getAttribute("aria-invalid")).toBe("true");

		// Editing the field clears the server verdict.
		await userEvent.type(username, "_2");
		expect(screen.queryByText("@minh đã có người dùng")).toBeNull();
	});
});
