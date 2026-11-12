// "Add this machine": one fixed command per shell (no code, no key, no
// language), the tab of the browser's system chosen first (Windows opens on
// PowerShell), the Linux note and the macOS Full Disk Access step, and the
// page turning to "connected" by itself once a new machine (or an offline
// machine of the account) comes online in the directory.
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { AddMachine, arrivedMachine, defaultTab, detectOs, installCommand } from "../../src/machines/add-machine.tsx";
import type { MachineEntry } from "../../src/machines/machines-client.ts";
import { ServicesContext, type Services } from "../../src/messaging/data/services.tsx";

/** CopyButton reports through the app's toasts. */
const services = { toasts: { show: () => undefined } } as unknown as Services;

/** The directory as each refresh returns it, the last one repeated. */
let readings: MachineEntry[][] = [];
const fakeHub = {
	refresh: vi.fn(async () => (readings.length > 1 ? (readings.shift() ?? []) : (readings[0] ?? []))),
};
vi.mock("../../src/machines/use-machines.ts", () => ({ useHub: () => fakeHub }));

const UA = {
	ubuntuFirefox: "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
	linuxChrome: "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
	chromeOs: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
	android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
	windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
	mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
};

const ORIGIN = "https://chat.example.test";
const nowSeconds = () => BigInt(Math.floor(Date.now() / 1000));

function entry(id: number, name: string, online: boolean, createdAt = 1): MachineEntry {
	return {
		ref: String(id),
		id,
		name,
		os: "darwin",
		arch: "arm64",
		agentVersion: "3.0.0",
		claudeVersion: "",
		tunnelUrl: online ? `wss://m-${id}.tunnel.hoandat.com` : "",
		createdAt,
		lastSeenAt: online ? Number(nowSeconds()) : 0,
		publicKey: new Uint8Array(32).fill(id),
	};
}

function renderPage(userAgent: string) {
	vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
	return render(
		<I18nProvider>
			<ServicesContext value={services}>
				<AddMachine />
			</ServicesContext>
		</I18nProvider>,
	);
}

beforeEach(() => {
	readings = [[]];
	fakeHub.refresh.mockClear();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("the install commands", () => {
	it("are the same for everyone: no code, no key, no language", () => {
		expect(installCommand("mac", ORIGIN)).toBe(`curl -fsSL ${ORIGIN}/agent/install.sh | sh`);
		expect(installCommand("linux", ORIGIN)).toBe(`curl -fsSL ${ORIGIN}/agent/install.sh | sh`);
		expect(installCommand("powershell", ORIGIN)).toBe(`irm ${ORIGIN}/agent/install.ps1 | iex`);
		expect(installCommand("cmd", ORIGIN)).toBe(`powershell -NoProfile -c "irm ${ORIGIN}/agent/install.ps1 | iex"`);
		expect(installCommand("cmd", ORIGIN)).not.toMatch(/ExecutionPolicy/);
	});

	it("the browser's system picks the first tab; Windows opens on PowerShell", () => {
		expect(detectOs(UA.ubuntuFirefox)).toBe("linux");
		expect(detectOs(UA.linuxChrome)).toBe("linux");
		expect(detectOs(UA.android)).toBe("phone");
		expect(detectOs(UA.chromeOs)).toBe("mac");
		expect(detectOs(UA.windows)).toBe("windows");
		expect(detectOs(UA.mac)).toBe("mac");
		expect(defaultTab("windows")).toBe("powershell");
		expect(defaultTab("mac")).toBe("mac");
		expect(defaultTab("linux")).toBe("linux");
	});
});

describe("the machine the page waits for", () => {
	it("is a new online machine, else an offline one that came online", () => {
		const before = new Map([
			[1, true],
			[2, false],
		]);
		const now = Date.now();
		expect(arrivedMachine(before, [entry(1, "A", true), entry(2, "B", false)], now)).toBeNull();
		// A new machine still without its tunnel is not there yet.
		expect(arrivedMachine(before, [entry(1, "A", true), entry(3, "C", false)], now)).toBeNull();
		expect(arrivedMachine(before, [entry(1, "A", true), entry(2, "B", true)], now)?.name).toBe("B");
		expect(arrivedMachine(before, [entry(1, "A", true), entry(2, "B", true), entry(3, "C", true, 5), entry(4, "D", true, 9)], now)?.name).toBe("D");
	});
});

describe("the Add machine page", () => {
	it("shows four tabs with their fixed command, Windows on PowerShell first", async () => {
		renderPage(UA.windows);
		const tabs = screen.getByRole("group", { name: "Hệ điều hành" });
		expect([...tabs.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["macOS", "Windows PowerShell", "Windows cmd", "Linux"]);
		expect(screen.getByRole("button", { name: "Windows PowerShell" }).getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByLabelText("Lệnh cài").textContent).toMatch(/^irm https?:\/\/[^ ]+\/agent\/install\.ps1 \| iex$/);
		await userEvent.click(screen.getByRole("button", { name: "Windows cmd" }));
		expect(screen.getByLabelText("Lệnh cài").textContent).toMatch(/^powershell -NoProfile -c "irm https?:\/\/[^ ]+\/agent\/install\.ps1 \| iex"$/);
		await userEvent.click(screen.getByRole("button", { name: "macOS" }));
		expect(screen.getByLabelText("Lệnh cài").textContent).toMatch(/^curl -fsSL https?:\/\/[^ ]+\/agent\/install\.sh \| sh$/);
		// Nothing about pairing codes is left on the page.
		expect(screen.queryByText(/mã ghép|Tạo lệnh cài/)).toBeNull();
	});

	it("from a Linux browser: Linux chosen, the systemd note shown, no Full Disk Access step", async () => {
		const { container } = renderPage(UA.ubuntuFirefox);
		expect(screen.getByRole("button", { name: "Linux" }).getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByText(/sudo loginctl enable-linger/)).toBeTruthy();
		expect(container.querySelector('[data-id="add-machine-disk-access"]')).toBeNull();
		// macOS brings its Full Disk Access step back, and drops the Linux note.
		await userEvent.click(screen.getByRole("button", { name: "macOS" }));
		expect(container.querySelector('[data-id="add-machine-disk-access"]')).not.toBeNull();
		expect(screen.queryByText(/sudo loginctl enable-linger/)).toBeNull();
	});

	it("turns to connected by itself when the new machine comes online, and opens it", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		readings = [[entry(1, "Old Mac", true)], [entry(1, "Old Mac", true)], [entry(1, "Old Mac", true), entry(7, "New PC", true, 99)]];
		renderPage(UA.mac);
		expect(await screen.findByText("Đang chờ máy kết nối…")).toBeTruthy();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(3_000);
		});
		expect(screen.queryByRole("link", { name: "Mở máy" })).toBeNull();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(3_000);
		});
		expect(await screen.findByText("Đã kết nối New PC")).toBeTruthy();
		expect(screen.getByRole("link", { name: "Mở máy" }).getAttribute("href")).toBe("/ai/7");
		// Done: the page stops asking the directory.
		const calls = fakeHub.refresh.mock.calls.length;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(9_000);
		});
		expect(fakeHub.refresh.mock.calls.length).toBe(calls);
	});

	it("a machine of the account that was offline and comes online counts too (tunelo installed again)", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		readings = [[entry(3, "Reinstalled", false)], [entry(3, "Reinstalled", true)]];
		renderPage(UA.mac);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(3_000);
		});
		expect(await screen.findByText("Đã kết nối Reinstalled")).toBeTruthy();
	});
});
