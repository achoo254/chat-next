// "Add this machine" from a Linux browser: the page recognises the system,
// shows the install.sh command with the Linux note and no Full Disk Access
// step (macOS only); a listed Linux machine gets the same quick install.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { AddMachine, detectOs, installCommand, quickInstallCommand } from "../../src/machines/add-machine.tsx";
import { QuickInstall } from "../../src/machines/pair-device.tsx";
import { ServicesContext, type Services } from "../../src/messaging/data/services.tsx";

/** CopyButton reports through the app's toasts. */
const services = { toasts: { show: () => undefined } } as unknown as Services;

// The page only asks the hub for this browser's key and the machines listed so far.
const fakeHub = {
	deps: { keys: { device: async () => ({ publicKey: new Uint8Array(32).fill(7) }) } },
	refresh: async () => [],
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

afterEach(() => vi.restoreAllMocks());

describe("Linux on the Add machine page", () => {
	it("recognises desktop Linux, but not Android or ChromeOS", () => {
		expect(detectOs(UA.ubuntuFirefox)).toBe("linux");
		expect(detectOs(UA.linuxChrome)).toBe("linux");
		expect(detectOs(UA.android)).toBe("phone");
		expect(detectOs(UA.chromeOs)).toBe("mac");
		expect(detectOs(UA.windows)).toBe("windows");
		expect(detectOs(UA.mac)).toBe("mac");
	});

	it("Linux runs the same install.sh as macOS", () => {
		const key = "A".repeat(43);
		const secret = "B".repeat(43);
		expect(installCommand("linux", "https://chat.example.test", key, secret, "vi")).toBe(`curl -fsSL https://chat.example.test/agent/install.sh | sh -s -- ${key} ${secret} vi`);
		expect(quickInstallCommand("linux", "https://chat.example.test", "en")).toBe("curl -fsSL https://chat.example.test/agent/install.sh | sh -s -- en");
	});

	it("from a Linux browser: Linux chosen, the systemd note shown, no Full Disk Access step", async () => {
		vi.spyOn(navigator, "userAgent", "get").mockReturnValue(UA.ubuntuFirefox);
		const { container } = render(
			<I18nProvider>
				<ServicesContext value={services}>
					<AddMachine />
				</ServicesContext>
			</I18nProvider>,
		);
		expect(screen.getByRole("button", { name: "Linux" }).getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByText(/sudo loginctl enable-linger/)).toBeTruthy();
		expect(screen.getByText("Chạy lệnh trong Terminal")).toBeTruthy();
		expect(container.querySelector('[data-id="add-machine-disk-access"]')).toBeNull();

		// The command is install.sh with this browser's key.
		await userEvent.click(await screen.findByRole("button", { name: "Tạo lệnh cài" }));
		expect((await screen.findByLabelText("Lệnh cài")).textContent).toMatch(/\/agent\/install\.sh \| sh -s -- [A-Za-z0-9_-]{43} [A-Za-z0-9_-]{43} vi$/);

		// macOS brings its Full Disk Access step back, and drops the Linux note.
		await userEvent.click(screen.getByRole("button", { name: "macOS" }));
		expect(container.querySelector('[data-id="add-machine-disk-access"]')).not.toBeNull();
		expect(screen.queryByText(/sudo loginctl enable-linger/)).toBeNull();
	});

	it("a listed Linux machine gets install.sh without asking for its system", () => {
		render(
			<I18nProvider>
				<ServicesContext value={services}>
					<QuickInstall machineOs="linux" />
				</ServicesContext>
			</I18nProvider>,
		);
		expect(screen.getByText(/install\.sh/)).toBeTruthy();
		expect(screen.queryByRole("group", { name: "Hệ điều hành của máy" })).toBeNull();
	});

	it("an unknown system offers Linux among the choices", async () => {
		render(
			<I18nProvider>
				<ServicesContext value={services}>
					<QuickInstall machineOs="" />
				</ServicesContext>
			</I18nProvider>,
		);
		await userEvent.click(screen.getByRole("button", { name: "Linux" }));
		expect(screen.getByRole("button", { name: "Linux" }).getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByText(/install\.sh/)).toBeTruthy();
	});
});
