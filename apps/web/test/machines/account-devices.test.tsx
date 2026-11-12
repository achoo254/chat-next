// The account's devices in the machines settings: each with its platform,
// when it was added and last used, this device marked, revoked ones shown
// as such, and revoking one by its key through the directory.
import { createRouterTransport } from "@connectrpc/connect";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { AccountDevices } from "../../src/machines/account-devices.tsx";
import { createMachinesDirectory, type MachinesDirectory } from "../../src/machines/machines-client.ts";
import { ServicesContext, type Services } from "../../src/messaging/data/services.tsx";
import { FakeMachines } from "../support/fake-machines.ts";

const services = { toasts: { show: () => undefined } } as unknown as Services;
const key = (n: number) => new Uint8Array(32).fill(n);
const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);

let service: FakeMachines;
let fakeHub: { device: () => Promise<void>; deps: { directory: MachinesDirectory } };

vi.mock("../../src/machines/use-machines.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/machines/use-machines.ts")>();
	return { ...actual, useHub: () => fakeHub };
});

beforeEach(() => {
	service = new FakeMachines();
	service.addDevice({ publicKey: key(1), name: "Chrome · Windows", platform: "web", createdAt: BigInt(now() - 3 * DAY), lastSeenAt: BigInt(now() - 120) });
	service.addDevice({ publicKey: key(2), name: "App Chat · iOS", platform: "ios", createdAt: BigInt(now() - DAY), lastSeenAt: 0n });
	service.addDevice({ publicKey: key(3), name: "Firefox · Linux", platform: "web", createdAt: BigInt(now() - 9 * DAY), revokedAt: BigInt(now() - 2 * DAY) });
	const directory = createMachinesDirectory(
		createRouterTransport((router) => service.routes(router)),
		() => undefined,
	);
	fakeHub = { device: () => Promise.resolve(), deps: { directory } };
});

function renderList() {
	return render(
		<I18nProvider>
			<ServicesContext value={services}>
				<AccountDevices />
			</ServicesContext>
		</I18nProvider>,
	);
}

describe("the account's devices", () => {
	it("lists every device with its platform, dates and state", async () => {
		renderList();
		const rows = await screen.findAllByRole("listitem");
		expect(rows).toHaveLength(3);
		expect(rows[0]?.textContent).toContain("Chrome · Windows");
		expect(rows[0]?.textContent).toMatch(/Trình duyệt · thêm ngày \d\d\/\d\d\/\d{4} · dùng lần cuối 2 phút trước/);
		expect(rows[1]?.textContent).toMatch(/iOS · thêm ngày \d\d\/\d\d\/\d{4} · chưa mở máy nào/);
		expect(rows[2]?.textContent).toMatch(/thu hồi ngày/);
		// A revoked device has nothing left to revoke.
		expect(within(rows[2] as HTMLElement).queryByRole("button")).toBeNull();
		expect(screen.queryByText("Thiết bị này")).toBeNull();
	});

	it("marks the device this session registered", async () => {
		// This page registers its own key first, as the hub does before listing.
		const directory = fakeHub.deps.directory;
		fakeHub.device = async () => {
			const challenge = await directory.keyChallenge();
			const { generateKeyPair, proveKeyPossession } = await import("@achoo254/chat-remote-protocol");
			const mine = await generateKeyPair();
			const mac = await proveKeyPossession(mine.privateKey, { serverKey: challenge.serverKey, nonce: challenge.nonce });
			await directory.registerDevice({ publicKey: mine.publicKey, name: "Safari · iPhone", platform: "pwa", challenge, mac });
		};
		renderList();
		const rows = await screen.findAllByRole("listitem");
		expect(rows).toHaveLength(4);
		const mine = rows[3] as HTMLElement;
		expect(within(mine).getByText("Thiết bị này")).toBeTruthy();
		expect(mine.textContent).toContain("App web");
	});

	it("revokes a device by its key after asking, and shows it revoked", async () => {
		const user = userEvent.setup();
		renderList();
		await user.click(await screen.findByRole("button", { name: "Thu hồi: Chrome · Windows" }));
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText(/bị đăng xuất khỏi tài khoản/)).toBeTruthy();
		await user.click(within(dialog).getByRole("button", { name: "Thu hồi" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(service.devices[0]?.revokedAt).not.toBe(0n);
		const row = screen.getAllByRole("listitem")[0] as HTMLElement;
		expect(row.textContent).toMatch(/thu hồi ngày/);
		expect(within(row).queryByRole("button")).toBeNull();
	});

	it("says when the list cannot load, and loads it again on demand", async () => {
		const user = userEvent.setup();
		const devices = vi.spyOn(fakeHub.deps.directory, "devices").mockRejectedValueOnce(new Error("offline"));
		renderList();
		expect(await screen.findByText("Không tải được danh sách thiết bị.")).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Thử lại" }));
		expect(await screen.findAllByRole("listitem")).toHaveLength(3);
		expect(devices).toHaveBeenCalledTimes(2);
	});
});
