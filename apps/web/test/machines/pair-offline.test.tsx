// The pairing page: an online machine asks for the 6-digit code of its
// Authenticator entry (nothing to run on it, so it works from a phone); a
// machine that is not connected gets no code boxes that silently refuse
// input, but what is wrong and what to run on it (for its own system), and
// the boxes open by themselves once it is online. A machine without
// Authenticator pairing gets the two ways to turn it on. The session column
// tells an online machine waiting to be paired from an offline one.
import { createConnectTransport } from "@connectrpc/connect-web";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { MachineLinksProvider } from "../../src/machines/link/connection-provider.tsx";
import { connOf } from "../../src/machines/machine-status.ts";
import { PairDevice, PairProblemView } from "../../src/machines/pair-device.tsx";
import { connDot } from "../../src/machines/session-sidebar.tsx";
import { ServicesContext, type Services } from "../../src/messaging/data/services.tsx";
import { FakeMachines } from "../support/fake-machines.ts";
import { routerFetch } from "../support/router-fetch.ts";

// jsdom has no IndexedDB: this device holds no machine key (not paired yet).
vi.mock("../../src/machines/link/device-keys.ts", () => ({
	deviceKeyStore: () => ({
		device: () => new Promise(() => undefined),
		pinned: async () => null,
		pin: async () => undefined,
		forget: async () => undefined,
	}),
}));

function page(machines: FakeMachines) {
	const transport = createConnectTransport({ baseUrl: "http://localhost/rpc", useBinaryFormat: true, fetch: routerFetch((r) => machines.routes(r)) });
	const services = { transport, toasts: { show: () => undefined } } as unknown as Services;
	return render(
		<I18nProvider>
			<ServicesContext value={services}>
				<MachineLinksProvider>
					<PairDevice machine="1" />
				</MachineLinksProvider>
			</ServicesContext>
		</I18nProvider>,
	);
}

describe("pairing with a machine", () => {
	it("not connected: says why and what to run on Windows, then opens the code boxes once it is online", async () => {
		const machines = new FakeMachines();
		const m = machines.add({ name: "DIEUVY-LAPTOP", os: "win32", arch: "x64", tunnelUrl: "", lastSeenAt: 0n });
		const view = page(machines);
		expect(await screen.findByText("DIEUVY-LAPTOP chưa kết nối")).toBeTruthy();
		expect(screen.getByText(/tunelo chưa chạy, hoặc máy còn bản cũ/)).toBeTruthy();
		expect(screen.getByText(/install\.ps1/)).toBeTruthy();
		expect(screen.getByText("tunelo start")).toBeTruthy();
		expect(screen.getByText("Rồi trong PowerShell chạy:")).toBeTruthy();
		expect(screen.getByText("Trang tự mở ô nhập mã ngay khi máy trực tuyến.")).toBeTruthy();
		// No code boxes that cannot be typed in.
		expect(view.container.querySelectorAll("input[inputmode=numeric]")).toHaveLength(0);

		m.tunnelUrl = "wss://m-1.tunnel.hoandat.com";
		m.lastSeenAt = BigInt(Math.floor(Date.now() / 1000));
		await waitFor(() => expect(view.container.querySelectorAll("input[inputmode=numeric]")).toHaveLength(6), { timeout: 8_000 });
		expect(screen.getByRole("group", { name: "Mã 6 số trong app Authenticator của máy này" })).toBeTruthy();
		expect(screen.queryByText("DIEUVY-LAPTOP chưa kết nối")).toBeNull();
		for (const box of view.container.querySelectorAll<HTMLInputElement>("input[inputmode=numeric]")) expect(box.disabled).toBe(false);
	}, 15_000);

	it("an online machine: the Authenticator code, the phone's one-time-code fill, and no command to run", async () => {
		const machines = new FakeMachines();
		machines.add({ name: "Mac mini", os: "darwin", tunnelUrl: "wss://m-2.tunnel.hoandat.com", lastSeenAt: BigInt(Math.floor(Date.now() / 1000)) });
		const view = page(machines);
		expect(await screen.findByText("Mở app Authenticator đã thêm Mac mini rồi nhập mã 6 số đang hiện.")).toBeTruthy();
		expect(screen.getByText(/Sai 5 lần thì máy khoá ghép thiết bị trong 15 phút/)).toBeTruthy();
		const boxes = view.container.querySelectorAll<HTMLInputElement>("input[inputmode=numeric]");
		expect(boxes).toHaveLength(6);
		expect(boxes[0]?.autocomplete).toBe("one-time-code");
		const text = view.container.textContent ?? "";
		for (const gone of ["tunelo pair", "QR", "10 phút", "Terminal", "PowerShell"]) expect(text).not.toContain(gone);
		expect(view.container.querySelector("video")).toBeNull();
	});
});

describe("a pairing that failed", () => {
	it("a machine without Authenticator pairing: the command that turns it on from the machine itself, and the paired-device way", () => {
		const services = { toasts: { show: () => undefined } } as unknown as Services;
		render(
			<I18nProvider>
				<ServicesContext value={services}>
					<PairProblemView problem="notSet" machine="Mac mini" />
				</ServicesContext>
			</I18nProvider>,
		);
		const alert = screen.getByRole("alert");
		expect(alert.getAttribute("data-id")).toBe("pair-not-set");
		expect(screen.getByText("Mac mini chưa bật ghép bằng Authenticator")).toBeTruthy();
		expect(screen.getByText(/Không cần cài lại/)).toBeTruthy();
		expect(screen.getByText("tunelo authenticator")).toBeTruthy();
		expect(screen.getByText(/Mở Cài đặt máy rồi chọn “Bật ghép bằng Authenticator”/)).toBeTruthy();
		expect(screen.queryByRole("link", { name: "Lấy lệnh cài" })).toBeNull();
	});

	it("a locked machine says for how long", () => {
		render(
			<I18nProvider>
				<PairProblemView problem="tooMany" machine="Mac mini" />
			</I18nProvider>,
		);
		expect(screen.getByRole("alert").textContent).toMatch(/Mac mini đang khoá ghép thiết bị trong 15 phút/);
	});
});

describe("the dot beside a machine", () => {
	it("tells online-but-not-paired from offline", () => {
		const idle = { status: { kind: "idle" as const } };
		const now = Date.now();
		const online = { ref: "1", lastSeenAt: Math.floor(now / 1000), tunnelUrl: "wss://x.tunnel.hoandat.com" };
		const offline = { ref: "1", lastSeenAt: 0, tunnelUrl: "" };
		expect(connDot(connOf(online, false, idle, now))).toBe("pair");
		expect(connDot(connOf(offline, false, idle, now))).toBe("off");
	});
});
