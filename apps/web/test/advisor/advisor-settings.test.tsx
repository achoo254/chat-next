// Settings › Cố vấn: the profile saves through the store (look, tone, name),
// the mascot shows or hides on this device, and a machine's own key is set or
// removed over the end-to-end link (AdvisorSetKey, AdvisorRemoveKey), also on
// a tunelo older than the account's key; an outdated machine says it needs a
// newer tunelo. The account's key: advisor-account-key.test.tsx.
import { createConnectTransport } from "@connectrpc/connect-web";
import type { AdvisorProfile } from "@achoo254/chat-core";
import { LoginState, type AdvisorSetKey, type Frame } from "@achoo254/chat-proto/remote/remote";
import { generateKeyPair, type KeyPair } from "@achoo254/chat-remote-protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advisorStore } from "../../src/advisor/advisor-store.ts";
import { viAdvisor } from "../../src/advisor/copy-vi.ts";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { MachineLinksProvider } from "../../src/machines/link/connection-provider.tsx";
import { ServicesContext, type Services } from "../../src/messaging/data/services.tsx";
import AdvisorSettings from "../../src/screens/settings/advisor-settings.tsx";
import { FakeMachines } from "../support/fake-machines.ts";
import { routerFetch } from "../support/router-fetch.ts";
import { defaultAnswer, FakeMachine } from "../machines/fake-machine.ts";

const t = viAdvisor;
const WAIT = { timeout: 4000 };
let machine: FakeMachine;
let device: KeyPair;
let keySet: boolean;
let known: boolean;
let setKeys: AdvisorSetKey[];
let removed: number;
let profile: AdvisorProfile;
let profileLoaded: boolean;
/** The machine's own automatic Advisor switch, and the values it was asked to take. */
let machineAuto: boolean;
let setAutos: boolean[];

vi.mock("../../src/machines/link/device-keys.ts", () => ({
	deviceKeyStore: () => ({
		device: async () => device,
		renew: async () => device,
		seenMachineKey: async () => null,
		rememberMachineKey: async () => undefined,
		forgetMachineKey: async () => undefined,
	}),
}));

vi.mock("../../src/messaging/data/services.tsx", async (importOriginal) => {
	const real = await importOriginal<typeof import("../../src/messaging/data/services.tsx")>();
	return { ...real, useAdvisorProfile: () => profile, useAdvisorProfileLoaded: () => profileLoaded };
});

const NativeWebSocket = window.WebSocket;

beforeEach(async () => {
	window.localStorage.clear();
	advisorStore.setHidden(false);
	keySet = false;
	known = true;
	setKeys = [];
	removed = 0;
	profile = { name: "", lookId: "owl", tone: "short", autoSession: false, keyRemovedAt: 0 };
	profileLoaded = true;
	machineAuto = false;
	setAutos = [];
	machine = await FakeMachine.create();
	device = await generateKeyPair();
	machine.trusted = [device.publicKey];
	machine.handler = (frame: Frame, socket) => {
		const b = frame.body;
		const info = () => ({
			case: "machineInfo" as const,
			value: {
				name: "Mac mini",
				os: "darwin",
				agentVersion: "3.13.0",
				providers: [{ id: "claude", name: "Claude Code", loginState: LoginState.OK, capabilities: { sessionMcp: true, advisorSession: true } }],
				...(known ? { advisor: { available: true, keySet, keyFingerprint: keySet ? "a1b2c3" : "", setByDevice: keySet ? "local" : "", setAt: keySet ? 1_800_000_000_000n : 0n, auto: machineAuto } } : {}),
			},
		});
		switch (b.case) {
			case "machineInfoRequest":
				return [info()];
			case "advisorSetKey":
				setKeys.push(b.value);
				keySet = true;
				setTimeout(() => machine.send(socket, info()), 0);
				return [{ case: "ack", value: {} }];
			case "advisorSetAuto":
				setAutos.push(b.value.on);
				machineAuto = b.value.on;
				setTimeout(() => machine.send(socket, info()), 0);
				return [{ case: "ack", value: {} }];
			case "advisorRemoveKey":
				removed += 1;
				keySet = false;
				setTimeout(() => machine.send(socket, info()), 0);
				return [{ case: "ack", value: {} }];
			default:
				return defaultAnswer(frame);
		}
	};
	window.WebSocket = function (url: string) {
		return machine.factory(url);
	} as unknown as typeof WebSocket;
});

afterEach(() => {
	window.WebSocket = NativeWebSocket;
});

function open(setAdvisorProfile = vi.fn(async (change: Partial<AdvisorProfile>) => ({ ...profile, ...change }))) {
	const machines = new FakeMachines();
	machines.add({ name: "Mac mini", tunnelUrl: "wss://m-1.tunnel.hoandat.com", lastSeenAt: BigInt(Math.floor(Date.now() / 1000)), publicKey: machine.keys.publicKey });
	const transport = createConnectTransport({ baseUrl: "http://localhost/rpc", useBinaryFormat: true, fetch: routerFetch((r) => machines.routes(r)) });
	const services = { toasts: { show: () => undefined }, transport, store: { setAdvisorProfile } } as unknown as Services;
	render(
		<I18nProvider>
			<ServicesContext value={services}>
				<MachineLinksProvider>
					<AdvisorSettings />
				</MachineLinksProvider>
			</ServicesContext>
		</I18nProvider>,
	);
	return setAdvisorProfile;
}

describe("Settings › Cố vấn", () => {
	it("saves the look, the tone and the name, and hides the mascot on this device only", async () => {
		const save = open();
		await userEvent.click(screen.getByRole("button", { name: "Mèo cam" }));
		expect(save).toHaveBeenLastCalledWith({ lookId: "cat" });
		await userEvent.click(screen.getByRole("button", { name: t.settings.tones.fun }));
		expect(save).toHaveBeenLastCalledWith({ tone: "fun" });
		await userEvent.type(screen.getByLabelText(t.settings.name), "Bé Cú{Enter}");
		expect(save).toHaveBeenLastCalledWith({ name: "Bé Cú" });
		await userEvent.click(screen.getByRole("switch", { name: t.settings.show }));
		expect(advisorStore.snapshot().hidden).toBe(true);
		expect(save).toHaveBeenCalledTimes(3);
	});

	it("saves the account's automatic Advisor switch, not a per-session one", async () => {
		const save = open();
		await userEvent.click(screen.getByRole("switch", { name: t.settings.auto }));
		expect(save).toHaveBeenLastCalledWith({ autoSession: true });
	});

	it("brings a linked machine in line with the account's switch, once", async () => {
		profile = { ...profile, autoSession: true };
		open();
		await waitFor(() => expect(setAutos).toEqual([true]), WAIT);
		// The machine's next info says it follows: nothing more is sent, nothing is reported as behind.
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(setAutos).toEqual([true]);
		expect(screen.queryByText(/Chưa áp dụng được trên/)).toBeNull();
	});

	it("never switches a machine before the profile is the user's own", async () => {
		machineAuto = true;
		profileLoaded = false;
		open();
		await screen.findByText(t.key.noKey, undefined, WAIT);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(setAutos).toEqual([]);
	});

	it("shows the TypeSafe key guide while no machine has a key and hides it once one does", async () => {
		open();
		await screen.findByText(t.key.noKey, undefined, WAIT);
		expect(screen.getByText(t.key.guide.title)).toBeTruthy();
		expect(screen.getByText(t.key.guide.notRunning)).toBeTruthy();
		expect(screen.getByRole("link", { name: t.key.guide.open }).getAttribute("href")).toBe(t.key.guide.consoleUrl);
	});

	it("hides the key guide when a machine already has a key", async () => {
		keySet = true;
		open();
		await screen.findByText(/a1b2c3/, undefined, WAIT);
		expect(screen.queryByText(t.key.guide.title)).toBeNull();
	});

	it("sets an older machine's own key over the link, shows its fingerprint and where it came from, and removes it", async () => {
		open();
		const card = await screen.findByText(t.key.noKey, undefined, WAIT);
		const row = card.closest(".adv-machine-key") as HTMLElement;
		expect(row.closest("[data-advisor-ignore]")).not.toBeNull();
		await userEvent.click(within(row).getByRole("button", { name: t.key.pasteOwn }));
		const field = within(row).getByLabelText(t.key.field) as HTMLInputElement;
		expect(field.type).toBe("password");
		await userEvent.type(field, "ts_live_0123456789abcdefghijklmnopqrstuvwxyz");
		await userEvent.click(within(row).getByRole("button", { name: t.key.save }));
		await waitFor(() => expect(setKeys.map((k) => k.key)).toEqual(["ts_live_0123456789abcdefghijklmnopqrstuvwxyz"]), WAIT);
		expect(await within(row).findByText(t.key.keySet("a1b2c3"), undefined, WAIT)).toBeTruthy();
		expect(within(row).getByText(new RegExp(t.key.localDevice))).toBeTruthy();
		expect(within(row).getByText(t.key.needsShare)).toBeTruthy();
		await userEvent.click(within(row).getByRole("button", { name: t.key.removeOwn }));
		await userEvent.click(within(row).getAllByRole("button", { name: t.key.removeOwn }).at(-1) as HTMLElement);
		await waitFor(() => expect(removed).toBe(1), WAIT);
		expect(await within(row).findByText(t.key.noKey, undefined, WAIT)).toBeTruthy();
	});

	it("says a machine needs a newer tunelo when it names no Advisor", async () => {
		known = false;
		open();
		expect(await screen.findByText(t.key.update, undefined, WAIT)).toBeTruthy();
		expect(screen.queryByRole("button", { name: t.key.pasteOwn })).toBeNull();
	});
});
